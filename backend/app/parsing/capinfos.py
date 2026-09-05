"""Reading a capture file's own header, via Wireshark's ``capinfos``.

tshark reports what is *in* the frames; the file header holds facts about the
capture itself -- the snapshot length, and the resolution the clock was
recorded at. Both are in the schema's ``capture`` block, and neither can be
recovered reliably from the frames.

The clock resolution is the one that matters. Guessing it from the timestamps
(“every sample ends in three zeros, so it must be microseconds”) is wrong for a
nanosecond capture whose packets happen to land on microsecond boundaries, and
this backend makes a point of not losing those digits. capinfos states it.

Failure here is not fatal. A document with an unknown snapshot length is still
a useful document, so the defaults stand and the reason is logged.
"""

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

#: capinfos prints "nanoseconds (9)" / "microseconds (6)".
_PRECISION = re.compile(r"\((\d)\)")


@dataclass(frozen=True, slots=True)
class CaptureInfo:
    """What the file header says about itself."""

    #: Bytes captured per frame, or 0 when the file does not record a limit.
    snaplen: int = 0
    #: Fractional digits the clock actually carries. Nine unless told otherwise.
    timestamp_digits: int = 9
    #: Frames the capture tool reported dropping, when it recorded any.
    packets_dropped: int = 0


def read_capture_info(binary: str, path: Path) -> CaptureInfo:
    """Read the header of ``path``. Returns defaults if capinfos cannot.

    ``-M`` asks for unpadded machine-readable values, so a snapshot length
    comes back as ``262144`` rather than ``262144 bytes``.
    """
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, shell=False, path is ours
            # -I asks for the per-interface block, which is where a pcapng
            # keeps its snapshot length.
            [binary, "-M", "-t", "-s", "-c", "-I", str(path)],
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        logger.warning("capinfos unavailable, using header defaults: %s", error)
        return CaptureInfo()

    if completed.returncode != 0:
        logger.warning("capinfos exited %s, using header defaults", completed.returncode)
        return CaptureInfo()

    return parse_capinfos(completed.stdout.decode("utf-8", "replace"))


def parse_capinfos(output: str) -> CaptureInfo:
    """Pull the fields worth having out of capinfos' key/value listing."""
    fields: dict[str, str] = {}
    for line in output.splitlines():
        # Top-level facts are "Key: value". The per-interface block indents its
        # entries and writes them "Key = value", so both are read -- otherwise
        # a pcapng's snapshot length, which only lives in that block, is missed.
        key, separator, value = line.partition(":")
        if not separator:
            key, separator, value = line.partition("=")
        if separator:
            fields[key.strip().lower()] = value.strip()

    return CaptureInfo(
        snaplen=_snaplen(fields),
        timestamp_digits=_digits(fields.get("file timestamp precision", "")),
        packets_dropped=_int_or(fields.get("packet drops", ""), 0),
    )


def _snaplen(fields: dict[str, str]) -> int:
    """The snapshot length, from wherever this file format keeps it.

    A pcap carries one in its file header. A pcapng carries one *per
    interface*, and capinfos reports the file header as ``(not set)`` for those
    -- so reading only that line would report 0 for the format this tool is
    mostly pointed at. The interface's ``Capture length`` is the fallback.
    """
    header = re.search(r"(\d+)", fields.get("packet size limit", ""))
    if header is not None:
        return int(header.group(1))
    return _int_or(fields.get("capture length", ""), 0)


def _digits(value: str) -> int:
    match = _PRECISION.search(value)
    if match is None:
        return 9
    digits = int(match.group(1))
    return digits if 1 <= digits <= 9 else 9


def _int_or(value: str, fallback: int) -> int:
    match = re.search(r"(\d+)", value)
    return int(match.group(1)) if match else fallback
