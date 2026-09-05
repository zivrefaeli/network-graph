"""The counting rules, fed decoded records directly.

Nothing here touches tshark, the filesystem, or FastAPI. That is the whole
point of keeping ``app/aggregation`` pure: the rules that decide whether the
graph tells the truth are testable without a capture file.
"""

from dataclasses import replace

import pytest

from app.aggregation.build import CaptureMeta, build_document
from app.parsing.records import HostnameClaim, PacketRecord
from app.schemas.graph import CaptureDocument, Counters, Edge, Machine, Node

MAC_PC = "00:1a:2b:3c:4d:5e"
MAC_ROUTER = "c8:d7:19:04:aa:31"
MAC_NAS = "00:11:32:8a:c4:7d"
MAC_RANDOM = "6a:3f:11:9d:02:c8"  # locally administered bit set
MAC_BROADCAST = "ff:ff:ff:ff:ff:ff"

# These are not free to change, and in particular they cannot be moved into the
# reserved documentation ranges. Locality branches on ``is_private``, and
# CPython reports *every* documentation range as private -- RFC 5737's
# 192.0.2/198.51.100/203.0.113, RFC 3849's 2001:db8::/32, and RFC 9637's
# 3fff::/20 alike. Putting REMOTE or PC_V6 in one would make the gateway tests
# pass against the very bug they exist to catch.
#
# So: hosts on the segment are RFC 1918, and anything standing in for the
# public internet is genuinely non-private. The v6 addresses use 4000::/3,
# which IANA has never allocated -- the only range that is both reserved and
# non-private, and so the only one that is safe and correct at once.
PC = "10.20.30.50"
ROUTER = "10.20.30.1"
NAS = "10.20.30.20"
REMOTE = "96.7.128.175"
OTHER_REMOTE = "23.215.0.136"

# IPv6 has no NAT, so a host's ordinary address is globally routable. PC_V6 and
# NAS_V6 share the on-link /64; REMOTE_V6 deliberately does not, because
# learning that prefix from the NAS is what has to carry the PC.
PC_V6 = "4001:db8:aced:1::50"
NAS_V6 = "4001:db8:aced:1::20"
REMOTE_V6 = "4001:db8:ffff::10"
# The EUI-64 forms of MAC_PC and MAC_ROUTER above.
PC_LINK_LOCAL = "fe80::21a:2bff:fe3c:4d5e"
ROUTER_LINK_LOCAL = "fe80::cad7:19ff:fe04:aa31"

BASE_NS = 1_788_513_300_123_456_789

META = CaptureMeta(id="cap_test", filename="test.pcapng", sha256="0" * 64)


class Clock:
    """Monotonic nanoseconds, so every record has a distinct, ordered stamp."""

    def __init__(self, start: int = BASE_NS) -> None:
        self._now = start

    def tick(self, step_ns: int = 1_000_000) -> int:
        self._now += step_ns
        return self._now


def ip_packet(
    clock: Clock,
    *,
    eth_src: str,
    eth_dst: str,
    ip_src: str,
    ip_dst: str,
    frame_len: int = 100,
    payload_len: int = 40,
    transport: str = "tcp",
    src_port: int = 40000,
    dst_port: int = 443,
    syn: bool = False,
    ack: bool = False,
    rst: bool = False,
    retransmission: bool = False,
    protocols: tuple[str, ...] = ("eth", "ethertype", "ip", "tcp"),
    hostnames: tuple[HostnameClaim, ...] = (),
) -> PacketRecord:
    return PacketRecord(
        number=0,
        epoch_ns=clock.tick(),
        frame_len=frame_len,
        eth_src=eth_src,
        eth_dst=eth_dst,
        ip_src=ip_src,
        ip_dst=ip_dst,
        ip_version=4,
        transport="tcp" if transport == "tcp" else "udp" if transport == "udp" else "icmp",
        src_port=src_port,
        dst_port=dst_port,
        payload_len=payload_len,
        tcp_syn=syn,
        tcp_ack=ack,
        tcp_rst=rst,
        tcp_retransmission=retransmission,
        protocols=protocols,
        hostnames=hostnames,
    )


def arp_reply(clock: Clock, *, mac: str, ip: str, to_mac: str = MAC_BROADCAST) -> PacketRecord:
    return PacketRecord(
        number=0,
        epoch_ns=clock.tick(),
        frame_len=42,
        eth_src=mac,
        eth_dst=to_mac,
        protocols=("eth", "arp"),
        arp_sender_ip=ip,
        arp_sender_mac=mac,
        arp_reply_ip=ip,
        arp_reply_mac=mac,
    )


def ip6_packet(
    clock: Clock,
    *,
    eth_src: str,
    eth_dst: str,
    ip_src: str,
    ip_dst: str,
    frame_len: int = 120,
    payload_len: int = 40,
) -> PacketRecord:
    return PacketRecord(
        number=0,
        epoch_ns=clock.tick(),
        frame_len=frame_len,
        eth_src=eth_src,
        eth_dst=eth_dst,
        ip_src=ip_src,
        ip_dst=ip_dst,
        ip_version=6,
        transport="tcp",
        src_port=40000,
        dst_port=443,
        payload_len=payload_len,
        protocols=("eth", "ethertype", "ipv6", "tcp"),
    )


def ndp_solicitation(clock: Clock, *, mac: str, ip_src: str, target: str) -> PacketRecord:
    """A neighbour solicitation, which is only ever sent for an on-link target.

    It names no MAC for that target -- the link-layer option in a solicitation
    is the *sender's* -- so this is presence evidence, never a binding.
    """
    return PacketRecord(
        number=0,
        epoch_ns=clock.tick(),
        frame_len=86,
        eth_src=mac,
        eth_dst="33:33:ff:00:00:01",
        ip_src=ip_src,
        ip_dst="ff02::1:ff00:1",
        ip_version=6,
        protocols=("eth", "ethertype", "ipv6", "icmpv6"),
        ndp_solicited_ip=target,
    )


def node_of(document: CaptureDocument, address: str) -> Node:
    for node in document.nodes:
        if node.id == f"ip:{address}":
            return node
    raise AssertionError(f"no node for {address}: {[n.id for n in document.nodes]}")


def machine_of(document: CaptureDocument, mac: str) -> Machine:
    for machine in document.machines:
        if machine.id == f"mac:{mac}":
            return machine
    raise AssertionError(f"no machine for {mac}: {[m.id for m in document.machines]}")


def direction(edge: Edge, *, sender: str) -> Counters:
    """The counters for traffic *from* ``sender``.

    Endpoints are sorted, so which of forward/reverse that is depends on
    lexicographic order. Asking by name keeps the tests readable and stops a
    mis-guess about ordering looking like a counting bug.
    """
    if edge.endpoints[0] == f"ip:{sender}":
        return edge.properties.forward
    if edge.endpoints[1] == f"ip:{sender}":
        return edge.properties.reverse
    raise AssertionError(f"{sender} is not on {edge.id}")


def edge_of(document: CaptureDocument, left: str, right: str) -> Edge:
    wanted = sorted([f"ip:{left}", f"ip:{right}"])
    for edge in document.edges:
        if list(edge.endpoints) == wanted:
            return edge
    raise AssertionError(f"no edge {wanted}: {[e.id for e in document.edges]}")


@pytest.fixture
def small_lan() -> CaptureDocument:
    """One PC, a gateway, a NAS, and a conversation with the internet.

    The last part is the one that matters: traffic to ``96.7.128.175`` is
    L2-addressed to the gateway on the way out and arrives with the gateway's
    MAC on the way back.
    """
    clock = Clock()
    records = [
        arp_reply(clock, mac=MAC_ROUTER, ip=ROUTER),
        arp_reply(clock, mac=MAC_PC, ip=PC),
        arp_reply(clock, mac=MAC_NAS, ip=NAS),
    ]
    # PC <-> NAS over SMB, asymmetric.
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_PC,
            eth_dst=MAC_NAS,
            ip_src=PC,
            ip_dst=NAS,
            src_port=49601,
            dst_port=445,
            syn=True,
            payload_len=0,
            frame_len=54,
        )
    )
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_NAS,
            eth_dst=MAC_PC,
            ip_src=NAS,
            ip_dst=PC,
            src_port=445,
            dst_port=49601,
            syn=True,
            ack=True,
            payload_len=0,
            frame_len=54,
        )
    )
    for _ in range(3):
        records.append(
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                src_port=49601,
                dst_port=445,
                ack=True,
                frame_len=1000,
                payload_len=946,
                protocols=("eth", "ethertype", "ip", "tcp", "smb2"),
            )
        )
    # PC <-> the internet, every frame L2-addressed to the router.
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_PC,
            eth_dst=MAC_ROUTER,
            ip_src=PC,
            ip_dst=REMOTE,
            src_port=49602,
            dst_port=443,
            syn=True,
            payload_len=0,
            frame_len=54,
        )
    )
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_ROUTER,
            eth_dst=MAC_PC,
            ip_src=REMOTE,
            ip_dst=PC,
            src_port=443,
            dst_port=49602,
            syn=True,
            ack=True,
            payload_len=0,
            frame_len=54,
            hostnames=(HostnameClaim(REMOTE, "example.com", "dns_ptr"),),
        )
    )
    for _ in range(4):
        records.append(
            ip_packet(
                clock,
                eth_src=MAC_ROUTER,
                eth_dst=MAC_PC,
                ip_src=REMOTE,
                ip_dst=PC,
                src_port=443,
                dst_port=49602,
                ack=True,
                frame_len=1454,
                payload_len=1400,
                protocols=("eth", "ethertype", "ip", "tcp", "tls"),
            )
        )
    # The gateway's own DNS.
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_PC,
            eth_dst=MAC_ROUTER,
            ip_src=PC,
            ip_dst=ROUTER,
            transport="udp",
            src_port=51514,
            dst_port=53,
            frame_len=86,
            payload_len=44,
            protocols=("eth", "ethertype", "ip", "udp", "dns"),
        )
    )
    records.append(
        ip_packet(
            clock,
            eth_src=MAC_ROUTER,
            eth_dst=MAC_PC,
            ip_src=ROUTER,
            ip_dst=PC,
            transport="udp",
            src_port=53,
            dst_port=51514,
            frame_len=137,
            payload_len=95,
            protocols=("eth", "ethertype", "ip", "udp", "dns"),
        )
    )
    return build_document(records, META)


class TestTheGatewayIsNotAHub:
    """The bug the whole L3 design exists to avoid."""

    def test_internet_traffic_is_a_conversation_with_the_remote_address(
        self, small_lan: CaptureDocument
    ) -> None:
        edge = edge_of(small_lan, PC, REMOTE)
        # 4 x 1454 inbound plus the SYN/ACK: this is the bulk of the capture.
        assert edge.properties.reverse.frame_bytes == 4 * 1454 + 54

    def test_the_gateway_carries_only_its_own_traffic(self, small_lan: CaptureDocument) -> None:
        gateway = node_of(small_lan, ROUTER)
        total = (
            gateway.properties.traffic.frame_bytes_sent
            + gateway.properties.traffic.frame_bytes_received
        )
        # Its DNS exchange, and nothing that merely passed through it.
        assert total == 86 + 137

    def test_no_l3_edge_terminates_on_a_mac(self, small_lan: CaptureDocument) -> None:
        for edge in small_lan.edges:
            if edge.layer != "l3":
                continue
            assert all(end.startswith("ip:") for end in edge.endpoints), edge.id

    def test_the_remote_address_gets_no_machine(self, small_lan: CaptureDocument) -> None:
        # Every frame carrying it had the router's MAC, in both directions.
        # Attributing it to the router is exactly the failure being prevented.
        remote = node_of(small_lan, REMOTE)
        assert remote.machine_id is None
        assert remote.inference is not None
        assert remote.inference.machine_bindings == []
        assert remote.node_type == "external"

    def test_the_router_is_typed_as_one(self, small_lan: CaptureDocument) -> None:
        assert node_of(small_lan, ROUTER).node_type == "router"


class TestTrafficRollsUp:
    """The cheap, high-value invariant that catches double-counting."""

    def test_every_address_equals_the_sum_of_its_edges(self, small_lan: CaptureDocument) -> None:
        for node in small_lan.nodes:
            sent = received = 0
            peers: set[str] = set()
            for edge in small_lan.edges:
                if edge.layer != "l3" or node.id not in edge.endpoints:
                    continue
                outbound = edge.endpoints[0] == node.id
                mine = edge.properties.forward if outbound else edge.properties.reverse
                theirs = edge.properties.reverse if outbound else edge.properties.forward
                sent += mine.frame_bytes
                received += theirs.frame_bytes
                peers.add(edge.endpoints[1] if outbound else edge.endpoints[0])
            assert node.properties.traffic.frame_bytes_sent == sent, node.id
            assert node.properties.traffic.frame_bytes_received == received, node.id
            assert node.properties.traffic.peer_count == len(peers), node.id

    def test_every_machine_equals_the_sum_of_its_addresses(
        self, small_lan: CaptureDocument
    ) -> None:
        by_id = {node.id: node for node in small_lan.nodes}
        for machine in small_lan.machines:
            expected = sum(
                by_id[node_id].properties.traffic.packets_sent
                for node_id in machine.node_ids
                if node_id in by_id
            )
            assert machine.properties.traffic.packets_sent == expected, machine.id

    def test_a_machine_with_two_addresses_sums_both(self) -> None:
        # The case the frontend renders as one ring with two sub-circles, and
        # the one where a naive implementation counts a packet twice.
        clock = Clock()
        vpn = "10.10.0.6"
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC),
            arp_reply(clock, mac=MAC_PC, ip=vpn),
            arp_reply(clock, mac=MAC_NAS, ip=NAS),
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                frame_len=500,
                payload_len=446,
            ),
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=vpn,
                ip_dst=NAS,
                frame_len=300,
                payload_len=246,
            ),
        ]
        document = build_document(records, META)
        machine = machine_of(document, MAC_PC)
        assert sorted(machine.node_ids) == [f"ip:{vpn}", f"ip:{PC}"]
        assert machine.properties.traffic.frame_bytes_sent == 800
        # One peer, reached from two of its own addresses. peer_count is
        # distinct peer *addresses*, deduplicated across the machine.
        assert machine.properties.traffic.peer_count == 1


class TestEdgesAreUndirected:
    def test_endpoints_come_out_sorted(self, small_lan: CaptureDocument) -> None:
        for edge in small_lan.edges:
            assert list(edge.endpoints) == sorted(edge.endpoints), edge.id

    def test_the_id_is_derived_from_the_sorted_pair(self, small_lan: CaptureDocument) -> None:
        for edge in small_lan.edges:
            left, right = edge.endpoints
            assert edge.id == f"edge_{left.replace(':', '-', 1)}_{right.replace(':', '-', 1)}"

    def test_only_the_namespace_colon_is_replaced(self) -> None:
        # An IPv6 id must stay readable, and must match the frontend's
        # derivation, which uses a single-occurrence replace.
        clock = Clock()
        records = [
            PacketRecord(
                number=0,
                epoch_ns=clock.tick(),
                frame_len=100,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src="4001:db8:aced:2::1",
                ip_dst="4001:db8:aced:2::2",
                ip_version=6,
                transport="tcp",
                src_port=40000,
                dst_port=443,
                payload_len=46,
            )
        ]
        document = build_document(records, META)
        assert document.edges[0].id == "edge_ip-4001:db8:aced:2::1_ip-4001:db8:aced:2::2"

    def test_the_same_conversation_yields_one_edge_whoever_spoke_first(self) -> None:
        def document_for(first_speaker: str, second: str) -> CaptureDocument:
            clock = Clock()
            return build_document(
                [
                    ip_packet(
                        clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=first_speaker, ip_dst=second
                    ),
                    ip_packet(
                        clock, eth_src=MAC_NAS, eth_dst=MAC_PC, ip_src=second, ip_dst=first_speaker
                    ),
                ],
                META,
            )

        forward = document_for(PC, NAS)
        backward = document_for(NAS, PC)
        assert [e.id for e in forward.edges] == [e.id for e in backward.edges]
        assert forward.edges[0].endpoints == backward.edges[0].endpoints

    def test_both_directions_are_kept_separately(self, small_lan: CaptureDocument) -> None:
        # "Who sent 4 GB to whom" is the question this tool answers, so a
        # single merged total is a regression.
        edge = edge_of(small_lan, PC, NAS)
        assert edge.properties.forward.frame_bytes != edge.properties.reverse.frame_bytes
        # The PC uploads; the NAS only acknowledges.
        assert direction(edge, sender=PC).packets == 4
        assert direction(edge, sender=NAS).packets == 1

    def test_forward_means_endpoints_zero_to_endpoints_one(
        self, small_lan: CaptureDocument
    ) -> None:
        edge = edge_of(small_lan, PC, REMOTE)
        # "ip:10.20.30.50" sorts before "ip:96.7.128.175", so forward really
        # is the PC's outbound direction here -- and the property under test is
        # that forward means endpoints[0] -> endpoints[1], nothing else.
        assert edge.endpoints[0] == f"ip:{PC}"
        assert edge.properties.forward is direction(edge, sender=PC)


class TestByteAccounting:
    def test_frame_and_payload_are_separate_accumulators(self, small_lan: CaptureDocument) -> None:
        uploaded = direction(edge_of(small_lan, PC, NAS), sender=PC)
        # Never derived from one another, and never equal by accident here:
        # one SYN carrying nothing, then three 1000-byte frames of 946 bytes.
        assert uploaded.frame_bytes == 54 + 3 * 1000
        assert uploaded.payload_bytes == 0 + 3 * 946
        assert uploaded.payload_bytes < uploaded.frame_bytes

    def test_a_handshake_carries_no_payload(self, small_lan: CaptureDocument) -> None:
        outbound = direction(edge_of(small_lan, PC, REMOTE), sender=PC)
        # The SYN is the only thing the PC sent, and it carried no payload.
        assert outbound.packets == 1
        assert outbound.payload_bytes == 0
        assert outbound.frame_bytes == 54


class TestFlowCounting:
    def test_flow_count_is_distinct_five_tuples_not_packets(self) -> None:
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                src_port=40000,
                dst_port=443,
            )
            for _ in range(50)
        ]
        edge = build_document(records, META).edges[0]
        assert direction(edge, sender=PC).packets == 50
        assert edge.properties.flow_count == 1

    def test_a_new_source_port_is_a_new_flow(self) -> None:
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                src_port=40000 + index,
                dst_port=443,
            )
            for index in range(7)
        ]
        assert build_document(records, META).edges[0].properties.flow_count == 7

    def test_both_directions_of_one_flow_are_one_flow(self) -> None:
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                src_port=40000,
                dst_port=443,
            ),
            ip_packet(
                clock,
                eth_src=MAC_NAS,
                eth_dst=MAC_PC,
                ip_src=NAS,
                ip_dst=PC,
                src_port=443,
                dst_port=40000,
            ),
        ]
        assert build_document(records, META).edges[0].properties.flow_count == 1


class TestServices:
    def test_the_server_side_port_is_chosen_not_the_ephemeral_one(self) -> None:
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                src_port=49601,
                dst_port=445,
                syn=True,
            ),
            ip_packet(
                clock,
                eth_src=MAC_NAS,
                eth_dst=MAC_PC,
                ip_src=NAS,
                ip_dst=PC,
                src_port=445,
                dst_port=49601,
                syn=True,
                ack=True,
            ),
        ]
        services = build_document(records, META).edges[0].properties.services
        assert [service.port for service in services] == [445]

    def test_transport_disambiguates_the_same_port_number(self) -> None:
        # TCP/53 and UDP/53 are different services and must not merge.
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_ROUTER,
                ip_src=PC,
                ip_dst=ROUTER,
                transport="udp",
                src_port=51514,
                dst_port=53,
            ),
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_ROUTER,
                ip_src=PC,
                ip_dst=ROUTER,
                transport="tcp",
                src_port=51515,
                dst_port=53,
                syn=True,
            ),
        ]
        services = build_document(records, META).edges[0].properties.services
        assert {(service.transport, service.port) for service in services} == {
            ("tcp", 53),
            ("udp", 53),
        }

    def test_l7_protocols_drop_the_framing_layers(self, small_lan: CaptureDocument) -> None:
        edge = edge_of(small_lan, PC, REMOTE)
        service = next(s for s in edge.properties.services if s.port == 443)
        assert service.l7_protocols == ["tls"]

    def test_service_counters_are_per_service(self, small_lan: CaptureDocument) -> None:
        edge = edge_of(small_lan, PC, ROUTER)
        assert [s.port for s in edge.properties.services] == [53]
        assert edge.properties.services[0].packets == 2


class TestScanDetection:
    def test_many_syns_and_no_syn_acks_is_visible(self) -> None:
        clock = Clock()
        records = [arp_reply(clock, mac=MAC_RANDOM, ip="10.20.30.77")]
        for index, port in enumerate(range(20, 20 + 64)):
            records.append(
                ip_packet(
                    clock,
                    eth_src=MAC_RANDOM,
                    eth_dst=MAC_PC,
                    ip_src="10.20.30.77",
                    ip_dst=PC,
                    src_port=40000 + index,
                    dst_port=port,
                    syn=True,
                    payload_len=0,
                    frame_len=54,
                )
            )
            records.append(
                ip_packet(
                    clock,
                    eth_src=MAC_PC,
                    eth_dst=MAC_RANDOM,
                    ip_src=PC,
                    ip_dst="10.20.30.77",
                    src_port=port,
                    dst_port=40000 + index,
                    rst=True,
                    ack=True,
                    payload_len=0,
                    frame_len=54,
                )
            )
        edge = build_document(records, META).edges[0]
        health = edge.properties.tcp_health
        assert health is not None
        assert health.syn_count == 64
        assert health.syn_ack_count == 0
        assert health.failed_handshakes == 64
        assert health.reset_count == 64
        # Nearly free in bytes, which is why line width alone would hide it.
        assert edge.properties.forward.payload_bytes == 0
        assert edge.properties.reverse.payload_bytes == 0
        # And loud in flows, which is what makes it legible.
        assert edge.properties.flow_count == 64

    def test_a_healthy_handshake_is_not_flagged(self, small_lan: CaptureDocument) -> None:
        health = edge_of(small_lan, PC, NAS).properties.tcp_health
        assert health is not None
        assert health.syn_count == 1
        assert health.syn_ack_count == 1
        assert health.failed_handshakes == 0

    def test_failed_handshakes_never_goes_negative(self) -> None:
        # A capture that starts mid-conversation can hold more SYN/ACKs than
        # SYNs. A negative count would be a lie about the file.
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_NAS,
                eth_dst=MAC_PC,
                ip_src=NAS,
                ip_dst=PC,
                src_port=445,
                dst_port=49601,
                syn=True,
                ack=True,
            )
        ]
        health = build_document(records, META).edges[0].properties.tcp_health
        assert health is not None
        assert health.failed_handshakes == 0

    def test_a_udp_only_edge_reports_no_tcp_health_rather_than_zeros(self) -> None:
        # Zeroed TCP health on a UDP conversation would read as a perfectly
        # healthy TCP session, which is worse than saying nothing.
        clock = Clock()
        records = [
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_ROUTER,
                ip_src=PC,
                ip_dst=ROUTER,
                transport="udp",
                src_port=51514,
                dst_port=53,
            )
        ]
        assert build_document(records, META).edges[0].properties.tcp_health is None


class TestMachineBinding:
    def test_an_arp_reply_binds_an_address_to_a_machine(self, small_lan: CaptureDocument) -> None:
        node = node_of(small_lan, PC)
        assert node.machine_id == f"mac:{MAC_PC}"
        assert node.inference is not None
        assert node.inference.machine_bindings[0].basis == "arp_reply"

    def test_an_address_seen_at_two_macs_keeps_both(self) -> None:
        # DHCP reassignment, MAC randomisation, or spoofing. All three are
        # worth seeing, so neither binding is resolved away.
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC),
            arp_reply(clock, mac=MAC_RANDOM, ip=PC),
            ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
        ]
        node = node_of(build_document(records, META), PC)
        assert node.inference is not None
        bases = {b.machine_id for b in node.inference.machine_bindings}
        assert bases == {f"mac:{MAC_PC}", f"mac:{MAC_RANDOM}"}

    def test_the_strongest_basis_wins_the_machine_id_slot(self) -> None:
        clock = Clock()
        records = [
            # Weak evidence first, strong evidence second.
            ip_packet(clock, eth_src=MAC_RANDOM, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
            arp_reply(clock, mac=MAC_PC, ip=PC),
        ]
        node = node_of(build_document(records, META), PC)
        assert node.machine_id == f"mac:{MAC_PC}"
        assert node.inference is not None
        assert node.inference.machine_bindings[0].basis == "arp_reply"

    def test_every_binding_carries_its_own_time_range(self) -> None:
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC),
            arp_reply(clock, mac=MAC_PC, ip=PC),
            ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
        ]
        node = node_of(build_document(records, META), PC)
        assert node.inference is not None
        binding = node.inference.machine_bindings[0]
        assert binding.first_seen < binding.last_seen

    def test_a_public_address_never_binds_to_the_router(self) -> None:
        # Inbound frames carry the router's MAC as their *source*, so
        # source-side evidence alone is not enough. This is the guard.
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_ROUTER, ip=ROUTER),
            arp_reply(clock, mac=MAC_PC, ip=PC),
            ip_packet(clock, eth_src=MAC_ROUTER, eth_dst=MAC_PC, ip_src=REMOTE, ip_dst=PC),
            ip_packet(clock, eth_src=MAC_ROUTER, eth_dst=MAC_PC, ip_src=OTHER_REMOTE, ip_dst=PC),
        ]
        document = build_document(records, META)
        router = machine_of(document, MAC_ROUTER)
        assert router.node_ids == [f"ip:{ROUTER}"]
        assert node_of(document, REMOTE).machine_id is None
        assert node_of(document, OTHER_REMOTE).machine_id is None

    def test_no_binding_observed_means_no_machine_and_a_stated_reason(
        self, small_lan: CaptureDocument
    ) -> None:
        node = node_of(small_lan, REMOTE)
        assert node.machine_id is None
        assert node.inference is not None
        # Never invent a parent -- but always say why there is none.
        assert node.inference.is_local_basis


class TestMachineIdentity:
    def test_a_randomized_mac_gets_no_vendor(self) -> None:
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_RANDOM, ip="10.20.30.77"),
            ip_packet(clock, eth_src=MAC_RANDOM, eth_dst=MAC_PC, ip_src="10.20.30.77", ip_dst=PC),
        ]
        machine = machine_of(build_document(records, META), MAC_RANDOM)
        assert machine.properties.mac_is_randomized is True
        assert machine.properties.vendor is None
        assert machine.properties.oui is None

    def test_a_burned_in_mac_keeps_its_oui(self, small_lan: CaptureDocument) -> None:
        machine = machine_of(small_lan, MAC_PC)
        assert machine.properties.mac_is_randomized is False
        assert machine.properties.oui == "00:1a:2b"

    def test_the_same_mac_on_two_vlans_is_two_machines(self) -> None:
        clock = Clock()
        shared = PacketRecord(
            number=0,
            epoch_ns=clock.tick(),
            frame_len=100,
            eth_src=MAC_PC,
            eth_dst=MAC_NAS,
            ip_src=PC,
            ip_dst=NAS,
            ip_version=4,
            transport="tcp",
            src_port=40000,
            dst_port=443,
            payload_len=46,
            vlan_id=10,
        )
        other = PacketRecord(
            number=0,
            epoch_ns=clock.tick(),
            frame_len=100,
            eth_src=MAC_PC,
            eth_dst=MAC_NAS,
            ip_src="10.20.31.5",
            ip_dst=NAS,
            ip_version=4,
            transport="tcp",
            src_port=40001,
            dst_port=443,
            payload_len=46,
            vlan_id=20,
        )
        document = build_document([shared, other], META)
        ours = [m for m in document.machines if m.properties.mac_address == MAC_PC]
        assert len(ours) == 2
        assert {m.properties.vlan_id for m in ours} == {10, 20}
        # The id has to distinguish them, which "mac:<address>" alone cannot.
        assert len({m.id for m in ours}) == 2

    def test_one_vlan_keeps_the_plain_id_readme_shows(self) -> None:
        clock = Clock()
        record = PacketRecord(
            number=0,
            epoch_ns=clock.tick(),
            frame_len=100,
            eth_src=MAC_PC,
            eth_dst=MAC_NAS,
            ip_src=PC,
            ip_dst=NAS,
            ip_version=4,
            transport="tcp",
            src_port=40000,
            dst_port=443,
            payload_len=46,
            vlan_id=10,
        )
        document = build_document([record], META)
        assert machine_of(document, MAC_PC).properties.vlan_id == 10


class TestLayer2:
    def test_arp_becomes_an_l2_edge_between_machines(self) -> None:
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC, to_mac=MAC_NAS),
            ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
        ]
        document = build_document(records, META)
        l2 = [edge for edge in document.edges if edge.layer == "l2"]
        assert len(l2) == 1
        # ARP has no IP header and so no address to attach to. Machines are the
        # only thing it can connect.
        assert all(end.startswith("mac:") for end in l2[0].endpoints)

    def test_an_l2_edge_reports_no_flows_rather_than_inventing_one(self) -> None:
        clock = Clock()
        document = build_document(
            [
                arp_reply(clock, mac=MAC_PC, ip=PC, to_mac=MAC_NAS),
                ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
            ],
            META,
        )
        l2 = next(edge for edge in document.edges if edge.layer == "l2")
        assert l2.properties.flow_count == 0
        assert l2.properties.tcp_health is None
        # ARP carries no L4 payload, so payload_bytes is 0 rather than invented
        # from the frame length.
        sender, other = sorted([f"mac:{MAC_PC}", f"mac:{MAC_NAS}"])
        from_pc = l2.properties.forward if sender == f"mac:{MAC_PC}" else l2.properties.reverse
        assert other  # both endpoints present
        assert from_pc.payload_bytes == 0
        assert from_pc.frame_bytes == 42

    def test_every_edge_endpoint_exists_in_the_document(self, small_lan: CaptureDocument) -> None:
        known = {node.id for node in small_lan.nodes} | {m.id for m in small_lan.machines}
        for edge in small_lan.edges:
            for endpoint in edge.endpoints:
                assert endpoint in known, f"{edge.id} points at {endpoint}"

    def test_a_broadcast_destination_still_resolves(self) -> None:
        clock = Clock()
        document = build_document(
            [
                arp_reply(clock, mac=MAC_PC, ip=PC, to_mac=MAC_BROADCAST),
                ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_NAS, ip_src=PC, ip_dst=NAS),
            ],
            META,
        )
        broadcast = machine_of(document, MAC_BROADCAST)
        assert broadcast.label == "broadcast"
        # It is a destination, not a device: no addresses, and not randomized
        # despite the locally-administered bit being set on 0xff.
        assert broadcast.node_ids == []
        assert broadcast.properties.mac_is_randomized is False


class TestHostnames:
    def test_a_name_is_attached_to_the_address_it_describes(
        self, small_lan: CaptureDocument
    ) -> None:
        # The PTR answer arrived in a frame *from* the remote address, but it
        # names that address, not the sender of the frame carrying it.
        assert [h.name for h in node_of(small_lan, REMOTE).properties.hostnames] == ["example.com"]

    def test_a_hostname_carries_a_confidence_on_the_machine(self) -> None:
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC),
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                hostnames=(HostnameClaim(PC, "workstation-01", "dhcp_option_12"),),
            ),
        ]
        machine = machine_of(build_document(records, META), MAC_PC)
        assert machine.label == "workstation-01"
        assert machine.inference is not None
        assert machine.inference.hostname_confidence == pytest.approx(0.9)

    def test_disagreeing_sources_are_all_kept(self) -> None:
        clock = Clock()
        records = [
            arp_reply(clock, mac=MAC_PC, ip=PC),
            ip_packet(
                clock,
                eth_src=MAC_PC,
                eth_dst=MAC_NAS,
                ip_src=PC,
                ip_dst=NAS,
                hostnames=(
                    HostnameClaim(PC, "pc.local", "mdns"),
                    HostnameClaim(PC, "PC", "nbns"),
                ),
            ),
        ]
        names = node_of(build_document(records, META), PC).properties.hostnames
        assert {h.source for h in names} == {"mdns", "nbns"}

    def test_a_machine_with_no_name_falls_back_rather_than_inventing_one(
        self, small_lan: CaptureDocument
    ) -> None:
        assert machine_of(small_lan, MAC_NAS).label == NAS


class TestDocumentShape:
    def test_an_empty_capture_is_refused_with_a_reason(self) -> None:
        with pytest.raises(ValueError, match="no frames"):
            build_document([], META)

    def test_a_conversation_with_itself_produces_no_edge(self) -> None:
        # There is no pair to sort, so it would break the identity every edge
        # id relies on.
        clock = Clock()
        document = build_document(
            [ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_PC, ip_src=PC, ip_dst=PC)],
            META,
        )
        assert document.edges == []

    def test_the_capture_window_spans_the_whole_file(self, small_lan: CaptureDocument) -> None:
        assert small_lan.capture.started_at < small_lan.capture.ended_at
        assert small_lan.capture.packets_total == 16

    def test_nanoseconds_survive_into_the_document(self, small_lan: CaptureDocument) -> None:
        assert small_lan.capture.started_at.endswith("Z")
        fraction = small_lan.capture.started_at.split(".")[1].rstrip("Z")
        assert len(fraction) == 9

    def test_the_schema_version_is_the_one_the_frontend_reads(
        self, small_lan: CaptureDocument
    ) -> None:
        assert small_lan.schema_version == "2.0"

    def test_machine_and_node_back_references_agree(self, small_lan: CaptureDocument) -> None:
        by_id = {node.id: node for node in small_lan.nodes}
        for machine in small_lan.machines:
            for node_id in machine.node_ids:
                assert by_id[node_id].machine_id == machine.id
        for node in small_lan.nodes:
            if node.machine_id is None:
                continue
            machine = next(m for m in small_lan.machines if m.id == node.machine_id)
            assert node.id in machine.node_ids


class TestIPv6Locality:
    """A v6 host on this segment is not a gateway.

    Judging locality by ``is_private`` is an IPv4-with-NAT assumption. Under
    IPv6 a host's ordinary address is a global unicast address, so that test
    brands every v6 host on the segment a router: each one sources frames whose
    address is not RFC 1918, which is the same evidence that legitimately
    identifies the real gateway.
    """

    @pytest.fixture
    def v6_lan(self) -> CaptureDocument:
        clock = Clock()
        return build_document(
            [
                arp_reply(clock, mac=MAC_ROUTER, ip=ROUTER),
                arp_reply(clock, mac=MAC_PC, ip=PC),
                # The only on-link evidence for the /64, and it names the NAS,
                # not the PC. Learning the prefix is what has to carry the PC.
                ndp_solicitation(clock, mac=MAC_ROUTER, ip_src=ROUTER_LINK_LOCAL, target=NAS_V6),
                # The PC talking to the internet over v6, both directions.
                ip6_packet(
                    clock,
                    eth_src=MAC_PC,
                    eth_dst=MAC_ROUTER,
                    ip_src=PC_V6,
                    ip_dst=REMOTE_V6,
                ),
                ip6_packet(
                    clock,
                    eth_src=MAC_ROUTER,
                    eth_dst=MAC_PC,
                    ip_src=REMOTE_V6,
                    ip_dst=PC_V6,
                ),
                # The NAS, whose address the solicitation above named. It is
                # here so there is something to check the solicitation did not
                # mis-attribute.
                ip6_packet(
                    clock,
                    eth_src=MAC_NAS,
                    eth_dst=MAC_ROUTER,
                    ip_src=NAS_V6,
                    ip_dst=REMOTE_V6,
                ),
            ],
            META,
        )

    def test_a_v6_host_talking_to_the_internet_is_not_a_router(
        self, v6_lan: CaptureDocument
    ) -> None:
        assert node_of(v6_lan, PC).node_type == "host"
        assert node_of(v6_lan, PC_V6).node_type == "host"

    def test_a_global_address_inside_an_on_link_prefix_is_local(
        self, v6_lan: CaptureDocument
    ) -> None:
        node = node_of(v6_lan, PC_V6)
        assert node.properties.is_local is True
        assert node.inference is not None
        assert node.inference.is_local_basis == "inside_an_on_link_ipv6_prefix"

    def test_that_address_belongs_to_the_machine_that_sourced_it(
        self, v6_lan: CaptureDocument
    ) -> None:
        # Without this the PC's v6 identity renders as a stranger on the
        # internet while its v4 address sits in the machine it came from.
        assert node_of(v6_lan, PC_V6).machine_id == f"mac:{MAC_PC}"
        assert f"ip:{PC_V6}" in machine_of(v6_lan, MAC_PC).node_ids

    def test_the_real_gateway_is_still_a_router(self, v6_lan: CaptureDocument) -> None:
        # The guard must not be so wide that it stops detecting the thing it
        # was written for: MAC_ROUTER forwarded an address outside every
        # on-link prefix, and nothing else here did.
        assert node_of(v6_lan, ROUTER).node_type == "router"

    def test_an_address_outside_every_on_link_prefix_stays_external(
        self, v6_lan: CaptureDocument
    ) -> None:
        remote = node_of(v6_lan, REMOTE_V6)
        assert remote.node_type == "external"
        assert remote.properties.is_local is False
        assert remote.machine_id is None

    def test_a_solicitation_does_not_bind_its_target_to_the_sender(
        self, v6_lan: CaptureDocument
    ) -> None:
        # The link-layer option in a solicitation is the sender's, not the
        # target's. The router solicited NAS_V6; treating that as a binding
        # would hand the NAS's address to the gateway.
        assert node_of(v6_lan, NAS_V6).machine_id == f"mac:{MAC_NAS}"


class TestLinkLocalBinding:
    def test_a_routers_own_link_local_binds_to_it(self) -> None:
        # The router guard on source_mac evidence exists to stop public
        # addresses binding to the gateway. A link-local address is never
        # forwarded, so the L2 sender *is* the L3 source -- even when that
        # sender is the router.
        clock = Clock()
        document = build_document(
            [
                arp_reply(clock, mac=MAC_ROUTER, ip=ROUTER),
                arp_reply(clock, mac=MAC_PC, ip=PC),
                ip_packet(
                    clock,
                    eth_src=MAC_ROUTER,
                    eth_dst=MAC_PC,
                    ip_src=REMOTE,
                    ip_dst=PC,
                ),
                ip6_packet(
                    clock,
                    eth_src=MAC_ROUTER,
                    eth_dst=MAC_PC,
                    ip_src=ROUTER_LINK_LOCAL,
                    ip_dst=PC_LINK_LOCAL,
                ),
            ],
            META,
        )
        assert node_of(document, ROUTER_LINK_LOCAL).machine_id == f"mac:{MAC_ROUTER}"


class TestPriorityTagging:
    def test_a_vlan_id_of_zero_is_not_a_second_machine(self) -> None:
        # 802.1Q with VID 0 is a priority tag: it carries no VLAN membership,
        # so it must not split one host into two machines.
        clock = Clock()
        tagged = replace(
            ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_ROUTER, ip_src=PC, ip_dst=REMOTE),
            vlan_id=0,
        )
        document = build_document(
            [
                arp_reply(clock, mac=MAC_PC, ip=PC),
                tagged,
                ip_packet(clock, eth_src=MAC_PC, eth_dst=MAC_ROUTER, ip_src=PC, ip_dst=REMOTE),
            ],
            META,
        )
        assert [m.id for m in document.machines if m.id.startswith(f"mac:{MAC_PC}")] == [
            f"mac:{MAC_PC}"
        ]
