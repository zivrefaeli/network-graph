"""The app factory, router registration, and the startup check.

tshark is an external binary, which is the cost of using Wireshark's dissectors
rather than reimplementing them. That cost is paid loudly at startup instead of
quietly at the first upload.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import captures, health
from app.parsing.tshark import TsharkNotFoundError, tshark_version
from app.settings import get_settings
from app.store import CaptureStore

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    app.state.store = CaptureStore()
    try:
        version = tshark_version(settings.tshark_bin)
    except TsharkNotFoundError as error:
        # Logged rather than raised. Refusing to start would take /health down
        # with it, and /health saying "tshark is missing, here is where I
        # looked" is far more actionable than a container that will not boot.
        logger.error("%s", error)
    else:
        logger.info("dissecting with %s", version)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="network-graph",
        version="0.1.0",
        summary="Turns a Wireshark capture into the graph document in README.md",
        lifespan=lifespan,
    )
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )
    app.include_router(health.router)
    app.include_router(captures.router)
    return app


app = create_app()
