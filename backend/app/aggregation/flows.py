"""Flow identity, and which end of a flow is the server.

``flow_count`` is distinct 5-tuples. It is what separates one long TLS session
from five thousand short connections at similar byte counts, and it is what
makes a scan legible, so it is never approximated by a packet count.
"""

from dataclasses import dataclass

from app.parsing.records import PacketRecord

#: A flow, normalised so both directions of one conversation share an identity.
type FlowKey = str


def flow_key(record: PacketRecord) -> FlowKey | None:
    """The 5-tuple, with the two ends sorted so direction does not split it.

    Returns None for a frame with no IP header, which is not a flow at all.
    """
    if record.ip_src is None or record.ip_dst is None:
        return None
    transport = record.transport or "none"
    left = (record.ip_src, record.src_port if record.src_port is not None else -1)
    right = (record.ip_dst, record.dst_port if record.dst_port is not None else -1)
    first, second = sorted([left, right])
    return f"{transport}|{first[0]}:{first[1]}|{second[0]}:{second[1]}"


@dataclass(slots=True)
class FlowFacts:
    """What a flow needs to remember to name its own server-side port."""

    #: Destination port of the first packet seen. The fallback answer.
    opening_dst_port: int | None
    #: Destination port of a SYN-without-ACK. The authoritative answer.
    syn_dst_port: int | None = None
    transport: str | None = None

    def observe(self, record: PacketRecord) -> None:
        if self.transport is None:
            self.transport = record.transport
        # A SYN with no ACK is a connection attempt, so its destination is by
        # definition the listening side. Nothing else is as good.
        if record.is_tcp_syn_only and self.syn_dst_port is None:
            self.syn_dst_port = record.dst_port

    @property
    def server_port(self) -> int | None:
        """The listening port, chosen per flow.

        The SYN's destination when there was one. Otherwise the destination of
        the first packet in the flow, which is right whenever the capture began
        before the conversation did and is a guess when it did not.
        """
        return self.syn_dst_port if self.syn_dst_port is not None else self.opening_dst_port


class FlowTable:
    """Per-flow facts, built as records stream past."""

    def __init__(self) -> None:
        self._flows: dict[FlowKey, FlowFacts] = {}

    def observe(self, record: PacketRecord) -> FlowKey | None:
        key = flow_key(record)
        if key is None:
            return None
        facts = self._flows.get(key)
        if facts is None:
            facts = FlowFacts(opening_dst_port=record.dst_port, transport=record.transport)
            self._flows[key] = facts
        facts.observe(record)
        return key

    def server_port(self, key: FlowKey) -> int | None:
        facts = self._flows.get(key)
        return facts.server_port if facts is not None else None

    def __len__(self) -> int:
        return len(self._flows)
