"""Upload a capture, and read back one that was uploaded earlier."""

import logging
import secrets
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, UploadFile, status

from app.parsing.pipeline import (
    CaptureTooLargeError,
    EmptyCaptureError,
    parse_capture,
    staged_upload,
)
from app.parsing.tshark import TsharkError, TsharkNotFoundError
from app.schemas.graph import CaptureDocument
from app.settings import Settings, get_settings

router = APIRouter(tags=["captures"])
logger = logging.getLogger(__name__)


def _new_capture_id() -> str:
    """Unguessable, so one client cannot enumerate another's uploads."""
    return f"cap_{secrets.token_hex(6)}"


async def _chunks(upload: UploadFile, settings: Settings) -> AsyncIterator[bytes]:
    while chunk := await upload.read(settings.upload_chunk_bytes):
        yield chunk


@router.post(
    "/captures",
    response_model=CaptureDocument,
    status_code=status.HTTP_201_CREATED,
)
async def create_capture(request: Request, file: UploadFile) -> CaptureDocument:
    """Dissect an uploaded capture and return the document for it.

    The upload streams to a temp file rather than into memory, is dissected by
    tshark in a worker thread, and the temp file is removed however this ends.
    """
    settings = get_settings()
    filename = file.filename or "capture.pcapng"
    capture_id = _new_capture_id()

    try:
        async with staged_upload(_chunks(file, settings), filename=filename, settings=settings) as (
            path,
            sha256,
            size,
        ):
            if size == 0:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, detail=f"{filename} is empty"
                )
            document = await parse_capture(
                path,
                capture_id=capture_id,
                filename=filename,
                sha256=sha256,
                settings=settings,
            )
    except CaptureTooLargeError as error:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail=str(error)) from error
    except EmptyCaptureError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
    except TsharkNotFoundError as error:
        # A configuration failure, not a bad upload. 503 says "come back when
        # the operator has fixed this", which 500 does not.
        logger.error("tshark is unavailable: %s", error)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    except TsharkError as error:
        # tshark's own stderr is logged rather than returned: it can name paths
        # on the server, and the client only needs to know dissection failed.
        logger.error("tshark failed on %s: %s", filename, error)
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="the dissector failed on this file; see the server log",
        ) from error
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error

    request.app.state.store.put(document)
    return document


@router.get("/captures/{capture_id}", response_model=CaptureDocument)
async def read_capture(request: Request, capture_id: str) -> CaptureDocument:
    """The document for an earlier upload, while this process still holds it."""
    document: CaptureDocument | None = request.app.state.store.get(capture_id)
    if document is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            # Says which of the two it is, because "restart the server and your
            # captures are gone" is behaviour worth being explicit about.
            detail=f"no capture {capture_id!r}; it was never uploaded, or this "
            "process has been restarted since it was",
        )
    return document
