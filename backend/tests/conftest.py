"""Shared fixtures, and the split between tests that need tshark and tests that do not."""

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings, get_settings

FIXTURES = Path(__file__).parent / "fixtures"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip the tshark-dependent tests when the binary is not on this host.

    The aggregation layer is pure and must pass anywhere, which is the whole
    reason it is separable. The parsing and API tests genuinely need Wireshark
    and run in the container.
    """
    del config
    if shutil.which(get_settings().tshark_bin) is not None:
        return
    skip = pytest.mark.skip(reason="tshark not on PATH; run these in the container")
    for item in items:
        if "tshark" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def tiny_capture() -> Path:
    return FIXTURES / "tiny.pcapng"


@pytest.fixture
def scan_capture() -> Path:
    return FIXTURES / "scan.pcapng"


@pytest.fixture
def settings() -> Settings:
    return get_settings()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """A client over a fresh app, so no capture leaks between tests."""
    with TestClient(create_app()) as test_client:
        yield test_client
