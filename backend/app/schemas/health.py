"""The health response. Typed like every other endpoint -- no bare dicts."""

from pydantic import BaseModel, ConfigDict


class Health(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    status: str
    #: Whether the dissector this service is built around is actually present.
    #: A "healthy" service that cannot parse anything is worse than a red light.
    tshark_available: bool
    tshark_version: str | None = None
    tshark_error: str | None = None
    captures_held: int
