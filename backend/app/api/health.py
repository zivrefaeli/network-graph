"""Liveness, and whether the thing this service depends on is actually there."""

from fastapi import APIRouter, Request

from app.parsing.tshark import TsharkNotFoundError, tshark_version
from app.schemas.health import Health
from app.settings import get_settings

router = APIRouter(tags=["health"])


@router.get("/health", response_model=Health)
async def health(request: Request) -> Health:
    """Report liveness and the tshark situation.

    Deliberately still 200 when tshark is missing: the process is up and can
    say what is wrong, which is more useful to a frontend than a connection
    error it cannot distinguish from the server being down.
    """
    settings = get_settings()
    store = request.app.state.store
    try:
        version = tshark_version(settings.tshark_bin)
    except TsharkNotFoundError as error:
        return Health(
            status="degraded",
            tshark_available=False,
            tshark_error=str(error),
            captures_held=len(store),
        )
    return Health(
        status="ok",
        tshark_available=True,
        tshark_version=version,
        captures_held=len(store),
    )
