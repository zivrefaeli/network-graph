"""Environment-driven configuration.

Every knob that differs between a laptop and the container lives here, so
nothing downstream reads ``os.environ`` directly.
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NG_", frozen=True)

    #: Where to find tshark. Overridable because it is a Homebrew path on a
    #: Mac, a PATH lookup in the container, and absent on a bare Windows host.
    tshark_bin: str = "tshark"

    #: Wireshark's capinfos, which reads the file header rather than the frames.
    #: Ships alongside tshark, so it is found the same way.
    capinfos_bin: str = "capinfos"

    #: A malformed or adversarial capture can send a dissector into a very long
    #: loop. The subprocess is killed rather than allowed to hold a worker
    #: thread forever.
    tshark_timeout_seconds: float = Field(default=120.0, gt=0)

    #: Captures are routinely gigabytes; uploads stream to disk in chunks and
    #: are refused past this rather than filling the volume.
    max_upload_bytes: int = Field(default=2 * 1024**3, gt=0)
    upload_chunk_bytes: int = Field(default=1024 * 1024, gt=0)

    #: Aggregation holds one record per packet in memory, so a capture past
    #: this is refused with a reason instead of being allowed to exhaust the
    #: machine. See backend/README.md for the ceiling this represents.
    max_packets: int = Field(default=2_000_000, gt=0)

    #: Where uploads are staged. None means the platform temp directory.
    upload_dir: Path | None = None

    #: Browsers that may call this service directly. Empty in development,
    #: where the frontend proxies /api and no cross-origin request is made.
    cors_origins: tuple[str, ...] = ()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Read the environment once. Cached so a route never re-parses it."""
    return Settings()
