"""The decoded packet record: the boundary between parsing and aggregation.

``app.parsing`` turns a capture file into a stream of these. ``app.aggregation``
turns a stream of these into a document. Nothing in aggregation knows tshark
exists, which is what makes the counting rules testable without a capture file
or a subprocess.
"""

from dataclasses import dataclass, field
from typing import Literal

type Transport = Literal["tcp", "udp", "icmp"]

BROADCAST_MAC = "ff:ff:ff:ff:ff:ff"


@dataclass(frozen=True, slots=True)
class HostnameClaim:
    """A name someone asserted for an address, and where it came from.

    Kept separate from the packet's own fields because the claim is often
    *about* a different address than the one that sent it: a TLS SNI names the
    server the client is connecting to, not the client.
    """

    address: str
    name: str
    source: Literal["dns_ptr", "mdns", "nbns", "dhcp_option_12", "tls_sni", "http_host"]


@dataclass(frozen=True, slots=True)
class PacketRecord:
    """One dissected frame, reduced to what the schema needs.

    Everything optional is ``None`` when the layer was absent, never a sentinel
    like ``0`` or ``""`` -- "no transport" and "port 0" are different facts.
    """

    number: int
    # Nanoseconds since the epoch. Never a float; see app.parsing.timestamps.
    epoch_ns: int
    # On the wire, including L2 headers. The schema's frame_bytes.
    frame_len: int

    eth_src: str | None = None
    eth_dst: str | None = None
    # Resolved by Wireshark's own manuf database, so no OUI table is bundled.
    eth_src_vendor: str | None = None
    eth_dst_vendor: str | None = None
    vlan_id: int | None = None

    ip_src: str | None = None
    ip_dst: str | None = None
    ip_version: Literal[4, 6] | None = None

    transport: Transport | None = None
    src_port: int | None = None
    dst_port: int | None = None
    # L4 payload only. The schema's payload_bytes. Zero for a bare handshake.
    payload_len: int = 0

    tcp_syn: bool = False
    tcp_ack: bool = False
    tcp_rst: bool = False
    tcp_retransmission: bool = False

    # The full dissection chain, e.g. ("eth", "ethertype", "ip", "tcp", "tls").
    # This is where l7_protocols comes from.
    protocols: tuple[str, ...] = ()

    # The interface the frame was captured on, per the file's own header.
    interface: str | None = None

    # Address-to-machine evidence, strongest first. ARP and NDP are assertions
    # about who holds an address; a plain source MAC is only circumstantial.
    #
    # arp_sender_* is populated for *any* ARP opcode, because a request's
    # "tell 192.168.1.20" is just as good a statement that the address is on
    # this segment. arp_reply_* is opcode 2 only, because only an unprompted
    # reply is strong enough to earn the arp_reply basis.
    arp_sender_ip: str | None = None
    arp_sender_mac: str | None = None
    arp_reply_ip: str | None = None
    arp_reply_mac: str | None = None
    ndp_advertised_ip: str | None = None
    ndp_advertised_mac: str | None = None
    dhcp_assigned_ip: str | None = None
    dhcp_assigned_mac: str | None = None

    hostnames: tuple[HostnameClaim, ...] = field(default=())

    @property
    def has_ip(self) -> bool:
        """Whether this frame carried an IP header at all.

        The frames that did not -- ARP, STP, LLDP -- have no address to attach
        a conversation to, and are the only thing that may become an l2 edge.
        """
        return self.ip_src is not None and self.ip_dst is not None

    @property
    def is_tcp_syn_only(self) -> bool:
        """A connection attempt: SYN set, ACK clear.

        The destination of one of these is the server side of the flow, and a
        pile of them with no answering SYN/ACK is a scan.
        """
        return self.transport == "tcp" and self.tcp_syn and not self.tcp_ack

    @property
    def is_tcp_syn_ack(self) -> bool:
        return self.transport == "tcp" and self.tcp_syn and self.tcp_ack
