"""Capture file in, document out. The one place parsing and aggregation meet.

Kept out of the router so the route stays a thin HTTP shell, and so this can be
called directly from a test without a client.
"""

import asyncio
import hashlib
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import mkdtemp

from app.aggregation.build import CaptureMeta, build_document
from app.parsing.capinfos import CaptureInfo, read_capture_info
from app.parsing.tshark import TsharkError, decode, run_tshark
from app.schemas.graph import CaptureDocument
from app.settings import Settings


class CaptureTooLargeError(ValueError):
    """The upload, or the packet count inside it, exceeded the configured cap."""


class EmptyCaptureError(ValueError):
    """Nothing in the file dissected into a frame this tool can use."""


@asynccontextmanager
async def staged_upload(
    stream: AsyncIterator[bytes], *, filename: str, settings: Settings
) -> AsyncIterator[tuple[Path, str, int]]:
    """Stream an upload to a temp file, yielding its path, sha256 and size.

    Never reads the upload into memory: captures are routinely gigabytes. The
    hash is computed as the bytes go past, so the file is walked once.

    The directory is removed in a ``finally``, including when dissection raises.
    """
    directory = Path(mkdtemp(dir=settings.upload_dir, prefix="ng-capture-"))
    # The client's filename is hostile input and never touches the filesystem.
    # It is carried into the document as data, not used as a path.
    path = directory / "capture.bin"
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("wb") as handle:
            async for chunk in stream:
                if not chunk:
                    continue
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise CaptureTooLargeError(
                        f"{filename} exceeds the {settings.max_upload_bytes} byte limit"
                    )
                digest.update(chunk)
                await asyncio.to_thread(handle.write, chunk)
        yield path, digest.hexdigest(), size
    finally:
        await asyncio.to_thread(shutil.rmtree, directory, True)


async def parse_capture(
    path: Path, *, capture_id: str, filename: str, sha256: str, settings: Settings
) -> CaptureDocument:
    """Dissect a staged capture and aggregate it into a document.

    Both halves are blocking -- tshark is a subprocess, aggregation is
    CPU-bound -- so both go to a worker thread. An ``async def`` route that ran
    either inline would stall every other request on the server.

    Raises:
        TsharkError: dissection failed or timed out.
        EmptyCaptureError: the file held no frames this tool can read.
        CaptureTooLargeError: more packets than ``settings.max_packets``.
    """
    # The file header first: it states the clock resolution, which the frames
    # cannot be trusted to reveal. Blocking, so it goes to a worker thread too.
    info = await asyncio.to_thread(read_capture_info, settings.capinfos_bin, path)
    output = await run_tshark(
        settings.tshark_bin, path, timeout_seconds=settings.tshark_timeout_seconds
    )
    return await asyncio.to_thread(
        _aggregate,
        output,
        info,
        capture_id=capture_id,
        filename=filename,
        sha256=sha256,
        max_packets=settings.max_packets,
    )


def _aggregate(
    output: str,
    info: CaptureInfo,
    *,
    capture_id: str,
    filename: str,
    sha256: str,
    max_packets: int,
) -> CaptureDocument:
    records = []
    for record in decode(output):
        records.append(record)
        if len(records) > max_packets:
            raise CaptureTooLargeError(
                f"{filename} holds more than {max_packets} frames. This build aggregates "
                "in memory; split the capture or raise NG_MAX_PACKETS."
            )
    if not records:
        raise EmptyCaptureError(
            f"{filename} produced no readable frames. It may not be a capture file, "
            "or may use a link type this build cannot dissect."
        )

    return build_document(
        records,
        CaptureMeta(
            id=capture_id,
            filename=filename,
            sha256=sha256,
            interface=records[0].interface or "unknown",
            snaplen=info.snaplen,
            packets_dropped=info.packets_dropped,
            # Every timestamp in one document reports the same precision, and
            # it is the file's stated resolution rather than a guess from the
            # values -- a nanosecond capture whose frames happen to land on
            # microsecond boundaries must not be demoted to six digits.
            timestamp_digits=info.timestamp_digits,
        ),
    )


__all__ = [
    "CaptureTooLargeError",
    "EmptyCaptureError",
    "TsharkError",
    "parse_capture",
    "staged_upload",
]
