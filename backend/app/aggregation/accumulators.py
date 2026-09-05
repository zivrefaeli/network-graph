"""Mutable tallies. The schema models are frozen results built from these once.

Two separate byte accumulators throughout: ``frame_bytes`` is on the wire
including L2 headers, ``payload_bytes`` is L4 payload only. Neither is ever
derived from the other, and they are never summed.
"""

from dataclasses import dataclass, field

from app.schemas.graph import Counters, TcpHealth, Traffic


@dataclass(slots=True)
class CounterAcc:
    packets: int = 0
    frame_bytes: int = 0
    payload_bytes: int = 0

    def add(self, *, frame_bytes: int, payload_bytes: int) -> None:
        self.packets += 1
        self.frame_bytes += frame_bytes
        self.payload_bytes += payload_bytes

    def freeze(self) -> Counters:
        return Counters(
            packets=self.packets,
            frame_bytes=self.frame_bytes,
            payload_bytes=self.payload_bytes,
        )


@dataclass(slots=True)
class TcpHealthAcc:
    syn_count: int = 0
    syn_ack_count: int = 0
    reset_count: int = 0
    retransmission_count: int = 0
    seen_tcp: bool = False

    @property
    def failed_handshakes(self) -> int:
        """Connection attempts that were never answered.

        Clamped at zero: a capture that starts mid-conversation can hold more
        SYN/ACKs than SYNs, and a negative count would be a lie about the file
        rather than a fact about the network.
        """
        return max(self.syn_count - self.syn_ack_count, 0)

    def freeze(self) -> TcpHealth | None:
        """None when the conversation carried no TCP at all.

        A UDP-only edge with zeroed TCP health would read as a perfectly
        healthy TCP conversation, which is worse than saying nothing.
        """
        if not self.seen_tcp:
            return None
        return TcpHealth(
            syn_count=self.syn_count,
            syn_ack_count=self.syn_ack_count,
            reset_count=self.reset_count,
            retransmission_count=self.retransmission_count,
            failed_handshakes=self.failed_handshakes,
        )


@dataclass(slots=True)
class ServiceAcc:
    port: int
    transport: str
    l7_protocols: set[str] = field(default_factory=set)
    packets: int = 0
    frame_bytes: int = 0
    flows: set[str] = field(default_factory=set)


@dataclass(slots=True)
class Window:
    """The first and last time something was seen, in integer nanoseconds."""

    first_ns: int
    last_ns: int

    @classmethod
    def at(cls, epoch_ns: int) -> "Window":
        return cls(epoch_ns, epoch_ns)

    def extend(self, epoch_ns: int) -> None:
        if epoch_ns < self.first_ns:
            self.first_ns = epoch_ns
        if epoch_ns > self.last_ns:
            self.last_ns = epoch_ns

    def merge(self, other: "Window") -> None:
        self.extend(other.first_ns)
        self.extend(other.last_ns)


@dataclass(slots=True)
class TrafficAcc:
    """A node's or machine's own totals, kept per direction.

    ``peers`` is a set rather than a count because ``peer_count`` is distinct
    peer *addresses*, deduplicated -- a machine talking to one host over four
    ports has one peer, not four.
    """

    packets_sent: int = 0
    packets_received: int = 0
    frame_bytes_sent: int = 0
    frame_bytes_received: int = 0
    peers: set[str] = field(default_factory=set)

    def add_sent(self, counters: Counters) -> None:
        self.packets_sent += counters.packets
        self.frame_bytes_sent += counters.frame_bytes

    def add_received(self, counters: Counters) -> None:
        self.packets_received += counters.packets
        self.frame_bytes_received += counters.frame_bytes

    def merge(self, other: "TrafficAcc") -> None:
        self.packets_sent += other.packets_sent
        self.packets_received += other.packets_received
        self.frame_bytes_sent += other.frame_bytes_sent
        self.frame_bytes_received += other.frame_bytes_received
        self.peers |= other.peers

    def freeze(self) -> Traffic:
        return Traffic(
            packets_sent=self.packets_sent,
            packets_received=self.packets_received,
            frame_bytes_sent=self.frame_bytes_sent,
            frame_bytes_received=self.frame_bytes_received,
            peer_count=len(self.peers),
        )
