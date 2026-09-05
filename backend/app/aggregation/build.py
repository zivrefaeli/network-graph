"""Packets in, schema document out. Pure: no I/O, no tshark, no FastAPI.

The counting rules live here, and they exist because the obvious
implementation produces a graph that misleads:

* **Edge endpoints are addresses.** Every packet headed off the segment is
  L2-addressed to the router, so an l3 edge terminating on a MAC collapses the
  entire internet onto the gateway. MAC is used *only* to group local addresses
  into machines.
* **Traffic rolls up.** An address's traffic is the sum of its edges'; a
  machine's is the sum of its addresses'. Both are asserted in the tests.
* **Edges are undirected.** The endpoint pair is sorted, the id is derived from
  the sorted pair, and ``forward`` means ``endpoints[0] -> endpoints[1]``, so
  the same conversation yields the same edge whoever spoke first.
"""

import ipaddress
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.aggregation.accumulators import (
    CounterAcc,
    ServiceAcc,
    TcpHealthAcc,
    TrafficAcc,
    Window,
)
from app.aggregation.classify import (
    Locality,
    classify_locality,
    classify_node_type,
    is_group_mac,
    mac_is_randomized,
    oui_of,
    parse_address,
    scope_of,
)
from app.aggregation.flows import FlowKey, FlowTable
from app.parsing.records import PacketRecord
from app.parsing.timestamps import format_rfc3339
from app.parsing.tshark import l7_protocols
from app.schemas.graph import (
    AddressInference,
    AddressProperties,
    Capture,
    CaptureDocument,
    Edge,
    EdgeProperties,
    Hostname,
    Machine,
    MachineBinding,
    MachineInference,
    MachineProperties,
    Node,
    Service,
)

#: How much a binding basis is worth when two disagree. The strongest wins the
#: ``machine_id`` slot; every one of them is still emitted as evidence.
_BASIS_CONFIDENCE: dict[str, float] = {
    "arp_reply": 0.98,
    "ndp_advertisement": 0.97,
    "dhcp_ack": 0.9,
    "source_mac": 0.6,
}
_BASIS_RANK: dict[str, int] = {
    "arp_reply": 3,
    "ndp_advertisement": 2,
    "dhcp_ack": 1,
    "source_mac": 0,
}

#: Confidence attached to a hostname, by how much the source can be trusted to
#: be talking about the address it is attached to.
_HOSTNAME_CONFIDENCE: dict[str, float] = {
    "dhcp_option_12": 0.9,
    "dns_ptr": 0.85,
    "mdns": 0.8,
    "nbns": 0.7,
    "tls_sni": 0.6,
    "http_host": 0.55,
}


@dataclass(frozen=True, slots=True)
class CaptureMeta:
    """Everything about the file that aggregation cannot work out for itself."""

    id: str
    filename: str
    sha256: str
    interface: str = "unknown"
    snaplen: int = 0
    packets_dropped: int = 0
    #: Fractional digits to emit. The capture's native resolution, decided once
    #: per document so two timestamps from one file never disagree about how
    #: precise the clock was.
    timestamp_digits: int = 9


@dataclass(slots=True)
class _BindingAcc:
    basis: str
    window: Window


@dataclass(slots=True)
class _AddressAcc:
    address: str
    version: int
    scope: str
    window: Window
    #: machine key -> the evidence for it. Every binding is kept; none is
    #: resolved away by picking a winner, because two of them means DHCP
    #: reassignment, MAC randomisation, or spoofing, and all three are worth
    #: seeing.
    bindings: dict[str, _BindingAcc] = field(default_factory=dict)
    hostnames: dict[tuple[str, str], None] = field(default_factory=dict)
    traffic: TrafficAcc = field(default_factory=TrafficAcc)
    seen_on_segment: bool = False
    sourced_from_macs: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _MachineAcc:
    """One (MAC, VLAN) pair. The same MAC on two VLANs is two machines."""

    mac: str
    vlan_id: int | None
    window: Window
    vendor: str | None = None


@dataclass(slots=True)
class _EdgeAcc:
    layer: str
    endpoints: tuple[str, str]
    window: Window
    forward: CounterAcc = field(default_factory=CounterAcc)
    reverse: CounterAcc = field(default_factory=CounterAcc)
    health: TcpHealthAcc = field(default_factory=TcpHealthAcc)
    flows: set[FlowKey] = field(default_factory=set)
    services: dict[tuple[str, int], ServiceAcc] = field(default_factory=dict)


#: SLAAC fixes the interface identifier at 64 bits (RFC 4291), so an address
#: observed on-link places its whole /64 on-link with it.
_ON_LINK_PREFIX_BITS = 64


@dataclass(frozen=True, slots=True)
class Segment:
    """The captured broadcast domain: what is on it, and what covers it.

    ``addresses`` is what ARP, NDP and DHCP named outright. ``on_link_prefixes``
    is the v6 generalisation of that, and it is load-bearing rather than a
    convenience -- see :func:`_on_link_prefixes`.
    """

    addresses: frozenset[str]
    on_link_prefixes: frozenset[ipaddress.IPv6Network]

    def holds(self, text: str) -> bool:
        """Whether this exact address was named in ARP, NDP or DHCP."""
        return text in self.addresses

    def covers(self, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        """Whether a learned on-link prefix contains this address.

        v6 only. A v4 host on this segment is already caught by ``is_private``,
        because v4 hosts sit behind NAT -- and that is exactly the assumption
        which does not carry over.
        """
        return isinstance(address, ipaddress.IPv6Address) and any(
            address in prefix for prefix in self.on_link_prefixes
        )


def build_document(records: Iterable[PacketRecord], meta: CaptureMeta) -> CaptureDocument:
    """Turn decoded packets into the document described in README.md."""
    packets = list(records)
    if not packets:
        raise ValueError("the capture contained no frames this tool could read")

    segment = _segment_of(packets)
    router_macs = _router_macs(packets, segment)

    state = _Aggregator(meta, segment, router_macs)
    for record in packets:
        state.consume(record)
    return state.finish(packet_count=len(packets))


def _segment_of(packets: Iterable[PacketRecord]) -> Segment:
    """What ARP, NDP and DHCP said is on this broadcast domain.

    Those protocols do not cross a router, so anything named in one is on the
    captured segment by construction. This is the strongest locality evidence
    available and it does not depend on address ranges at all.
    """
    found: set[str] = set()
    for record in packets:
        for address in (
            # Any opcode: a request's "tell 10.20.30.20" places the sender on
            # this segment exactly as a reply does.
            record.arp_sender_ip,
            record.ndp_advertised_ip,
            # A solicitation is only ever sent for an on-link target, so it is
            # presence evidence even though it binds nothing.
            record.ndp_solicited_ip,
            record.dhcp_assigned_ip,
        ):
            if address:
                found.add(address)
    return Segment(frozenset(found), _on_link_prefixes(found))


def _on_link_prefixes(addresses: Iterable[str]) -> frozenset[ipaddress.IPv6Network]:
    """The /64s of the v6 addresses observed on this segment.

    This is the half of locality that IPv4 never needed. There is no NAT in
    IPv6, so a host's ordinary address is a *global unicast* address: judging
    locality by ``is_private`` marks every v6 host on the segment off-segment,
    and :func:`_router_macs` then reads each one as a gateway, because sourcing
    frames for an off-segment address is precisely what a router does.

    Neighbour discovery names only on-link addresses, and SLAAC fixes the
    prefix at /64, so the /64 of an address seen in NDP is on-link too. That
    generalises the evidence to the neighbours whose own addresses never
    appeared in a solicitation -- which, in a short capture, is most of them.

    Link-local is skipped: fe80::/64 is on-link everywhere by definition and is
    already handled as such, so learning it would add nothing.
    """
    prefixes: set[ipaddress.IPv6Network] = set()
    for text in addresses:
        parsed = parse_address(text)
        if not isinstance(parsed, ipaddress.IPv6Address):
            continue
        if parsed.is_link_local or parsed.is_multicast or parsed.is_loopback:
            continue
        prefixes.add(ipaddress.IPv6Network((parsed, _ON_LINK_PREFIX_BITS), strict=False))
    return frozenset(prefixes)


def _router_macs(packets: Iterable[PacketRecord], segment: Segment) -> set[str]:
    """MACs that forwarded traffic for addresses that are not on this segment.

    Only a router does that. Identifying it here is what lets the binding rule
    below refuse to credit the gateway with every address on the internet.

    Note the asymmetry with binding: this *does* look at the destination MAC,
    and legitimately so. "Which MAC is the next hop off-segment" is exactly the
    question a destination MAC answers. Attributing an *address* to that MAC is
    the thing that would be wrong.
    """
    routers: set[str] = set()
    for record in packets:
        if not record.has_ip:
            continue
        source = parse_address(record.ip_src or "")
        destination = parse_address(record.ip_dst or "")
        if (
            source is not None
            and record.eth_src
            and not is_group_mac(record.eth_src)
            and _is_off_segment(source, record.ip_src or "", segment)
        ):
            routers.add(record.eth_src)
        if (
            destination is not None
            and record.eth_dst
            and not is_group_mac(record.eth_dst)
            and _is_off_segment(destination, record.ip_dst or "", segment)
        ):
            routers.add(record.eth_dst)
    return routers


def _is_off_segment(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address, text: str, segment: Segment
) -> bool:
    if segment.holds(text):
        return False
    if address.is_multicast or address.is_loopback or address.is_link_local:
        return False
    if segment.covers(address):
        return False
    return not address.is_private


class _Aggregator:
    """One pass over the packets, tallying into the accumulators above."""

    def __init__(self, meta: CaptureMeta, segment: Segment, router_macs: set[str]) -> None:
        self._meta = meta
        self._segment = segment
        self._router_macs = router_macs
        self._addresses: dict[str, _AddressAcc] = {}
        self._machines: dict[str, _MachineAcc] = {}
        self._edges: dict[str, _EdgeAcc] = {}
        self._flows = FlowTable()
        self._window: Window | None = None
        # A MAC seen on more than one VLAN is more than one machine, and the
        # id has to say so. Tracked here so ids can be assigned at the end.
        self._vlans_per_mac: dict[str, set[int | None]] = {}

    # -- ingestion ---------------------------------------------------------

    def consume(self, record: PacketRecord) -> None:
        self._window = (
            Window.at(record.epoch_ns)
            if self._window is None
            else self._extend(self._window, record.epoch_ns)
        )
        self._note_macs(record)
        self._note_bindings(record)
        self._note_hostnames(record)

        if record.has_ip:
            self._consume_l3(record)
        else:
            self._consume_l2(record)

    @staticmethod
    def _extend(window: Window, epoch_ns: int) -> Window:
        window.extend(epoch_ns)
        return window

    def _note_macs(self, record: PacketRecord) -> None:
        for mac, vendor in (
            (record.eth_src, record.eth_src_vendor),
            (record.eth_dst, record.eth_dst_vendor),
        ):
            if not mac:
                continue
            key = _machine_key(mac, _vlan_of(record))
            machine = self._machines.get(key)
            if machine is None:
                self._machines[key] = _MachineAcc(
                    mac=mac,
                    vlan_id=_vlan_of(record),
                    window=Window.at(record.epoch_ns),
                    vendor=vendor,
                )
            else:
                machine.window.extend(record.epoch_ns)
                if machine.vendor is None and vendor is not None:
                    machine.vendor = vendor
            self._vlans_per_mac.setdefault(mac, set()).add(_vlan_of(record))

    def _note_bindings(self, record: PacketRecord) -> None:
        """Record every address-to-machine assertion this frame carried.

        Source-side only, and *local addresses only*. README.md gives the first
        half of that rule; the second half is what stops the gateway swallowing
        the internet, because every inbound packet has the router's MAC as its
        source too.
        """
        claims: list[tuple[str | None, str | None, str]] = [
            (record.arp_reply_ip, record.arp_reply_mac, "arp_reply"),
            (record.ndp_advertised_ip, record.ndp_advertised_mac, "ndp_advertisement"),
            (record.dhcp_assigned_ip, record.dhcp_assigned_mac, "dhcp_ack"),
        ]
        # The weakest evidence, and the one that needs the guard: this address
        # was the source of a frame that left this MAC.
        if record.ip_src and record.eth_src and not is_group_mac(record.eth_src):
            claims.append((record.ip_src, record.eth_src, "source_mac"))

        for address, mac, basis in claims:
            if not address or not mac:
                continue
            if basis == "source_mac" and not self._could_be_local(address, mac):
                continue
            acc = self._address(address, record.epoch_ns)
            if acc is None:
                continue
            acc.sourced_from_macs.add(mac)
            key = _machine_key(mac, _vlan_of(record))
            existing = acc.bindings.get(key)
            if existing is None:
                acc.bindings[key] = _BindingAcc(basis, Window.at(record.epoch_ns))
            else:
                existing.window.extend(record.epoch_ns)
                if _BASIS_RANK[basis] > _BASIS_RANK[existing.basis]:
                    existing.basis = basis

    def _could_be_local(self, address: str, mac: str) -> bool:
        """The guard on ``source_mac`` evidence.

        An address is a candidate for binding only if it was seen in ARP/NDP on
        this segment, or is private/link-local and arrived from a MAC that is
        not a router. Without the router clause, every public address on the
        internet would bind to the gateway, which is the exact bug the L3
        design exists to avoid.
        """
        if self._segment.holds(address):
            return True
        parsed = parse_address(address)
        if parsed is None or parsed.is_multicast:
            return False
        # A link-local address is never forwarded, so the L2 sender *is* the L3
        # source. That holds even when the sender is the router, and testing it
        # before the guard below is what lets a router keep its own fe80::
        # address rather than end up with none at all.
        if parsed.is_link_local:
            return True
        # An on-link prefix is observed evidence, so it outranks the guard for
        # the same reason an ARP-named address does.
        if self._segment.covers(parsed):
            return True
        if mac in self._router_macs:
            return False
        return parsed.is_private

    def _note_hostnames(self, record: PacketRecord) -> None:
        for claim in record.hostnames:
            acc = self._address(claim.address, record.epoch_ns)
            if acc is not None:
                acc.hostnames[(claim.name, claim.source)] = None

    def _address(self, text: str, epoch_ns: int) -> _AddressAcc | None:
        parsed = parse_address(text)
        if parsed is None:
            return None
        acc = self._addresses.get(text)
        if acc is None:
            acc = _AddressAcc(
                address=text,
                version=parsed.version,
                scope=scope_of(parsed),
                window=Window.at(epoch_ns),
            )
            self._addresses[text] = acc
        else:
            acc.window.extend(epoch_ns)
        if self._segment.holds(text):
            acc.seen_on_segment = True
        return acc

    def _consume_l3(self, record: PacketRecord) -> None:
        source_text = record.ip_src or ""
        destination_text = record.ip_dst or ""
        source = self._address(source_text, record.epoch_ns)
        destination = self._address(destination_text, record.epoch_ns)
        if source is None or destination is None:
            return
        if source_text == destination_text:
            # A conversation with itself has no two endpoints to sort, and
            # would break the "sorted pair" identity every edge id relies on.
            return

        first, second = sorted([f"ip:{source_text}", f"ip:{destination_text}"])
        edge = self._edge("l3", (first, second), record.epoch_ns)
        forward = first == f"ip:{source_text}"

        counters = edge.forward if forward else edge.reverse
        counters.add(frame_bytes=record.frame_len, payload_bytes=record.payload_len)
        self._note_tcp(edge, record)

        key = self._flows.observe(record)
        if key is not None:
            edge.flows.add(key)
            self._note_service(edge, record, key)

    def _consume_l2(self, record: PacketRecord) -> None:
        """A frame with no IP header: ARP, STP, LLDP.

        These have no address to attach a conversation to, and so are the only
        thing that may become an l2 edge between two machines.
        """
        if not record.eth_src or not record.eth_dst or record.eth_src == record.eth_dst:
            return
        source_id = f"mac:{record.eth_src}"
        destination_id = f"mac:{record.eth_dst}"
        first, second = sorted([source_id, destination_id])
        edge = self._edge("l2", (first, second), record.epoch_ns)
        counters = edge.forward if first == source_id else edge.reverse
        # An ARP frame carries no L4 payload at all, so payload_bytes stays 0
        # rather than being invented from the frame length.
        counters.add(frame_bytes=record.frame_len, payload_bytes=0)

    def _edge(self, layer: str, endpoints: tuple[str, str], epoch_ns: int) -> _EdgeAcc:
        edge_id = _edge_id(endpoints)
        edge = self._edges.get(edge_id)
        if edge is None:
            edge = _EdgeAcc(layer=layer, endpoints=endpoints, window=Window.at(epoch_ns))
            self._edges[edge_id] = edge
        else:
            edge.window.extend(epoch_ns)
        return edge

    @staticmethod
    def _note_tcp(edge: _EdgeAcc, record: PacketRecord) -> None:
        if record.transport != "tcp":
            return
        edge.health.seen_tcp = True
        if record.is_tcp_syn_only:
            edge.health.syn_count += 1
        elif record.is_tcp_syn_ack:
            edge.health.syn_ack_count += 1
        if record.tcp_rst:
            edge.health.reset_count += 1
        if record.tcp_retransmission:
            edge.health.retransmission_count += 1

    def _note_service(self, edge: _EdgeAcc, record: PacketRecord, key: FlowKey) -> None:
        port = self._flows.server_port(key)
        if port is None or record.transport is None:
            return
        service_key = (record.transport, port)
        service = edge.services.get(service_key)
        if service is None:
            service = ServiceAcc(port=port, transport=record.transport)
            edge.services[service_key] = service
        service.packets += 1
        service.frame_bytes += record.frame_len
        service.flows.add(key)
        service.l7_protocols.update(l7_protocols(record.protocols))

    # -- assembly ----------------------------------------------------------

    def finish(self, *, packet_count: int) -> CaptureDocument:
        machine_ids = self._assign_machine_ids()
        localities = self._resolve_localities()
        bound = self._resolve_bindings(machine_ids)
        self._roll_up_traffic(bound)

        nodes = self._build_nodes(localities, bound, machine_ids)
        machines = self._build_machines(machine_ids, bound, localities)
        edges = self._build_edges()
        return CaptureDocument(
            capture=self._build_capture(packet_count),
            machines=machines,
            nodes=nodes,
            edges=edges,
        )

    def _assign_machine_ids(self) -> dict[str, str]:
        """Map each (MAC, VLAN) key to the id the document will use.

        README.md keys a machine by MAC *and* VLAN but spells the id
        ``mac:<address>``, which cannot express both. The plain form is used
        whenever a MAC was seen on one VLAN -- overwhelmingly the common case,
        and exactly what README.md's examples show -- and a ``@vlan`` suffix is
        added only where a MAC genuinely appeared on more than one, so the two
        machines the key demands get two ids. See README of this package.
        """
        ids: dict[str, str] = {}
        for key, machine in self._machines.items():
            vlans = self._vlans_per_mac.get(machine.mac, set())
            if len(vlans) <= 1:
                ids[key] = f"mac:{machine.mac}"
            else:
                tag = "untagged" if machine.vlan_id is None else f"vlan{machine.vlan_id}"
                ids[key] = f"mac:{machine.mac}@{tag}"
        return ids

    def _resolve_localities(self) -> dict[str, Locality]:
        return {
            text: classify_locality(
                parsed,
                on_segment=acc.seen_on_segment,
                on_link_prefix=self._segment.covers(parsed),
                bound_to_non_router=bool(acc.sourced_from_macs - self._router_macs),
            )
            for text, acc in self._addresses.items()
            if (parsed := parse_address(text)) is not None
        }

    def _resolve_bindings(self, machine_ids: dict[str, str]) -> dict[str, str]:
        """Pick the binding in effect for each address.

        Strongest basis wins; a tie goes to whichever was seen most recently.
        Every binding is still emitted in ``machine_bindings`` -- this only
        chooses which one ``machine_id`` names.
        """
        chosen: dict[str, str] = {}
        for text, acc in self._addresses.items():
            best: tuple[int, int, str] | None = None
            for key, binding in acc.bindings.items():
                rank = (_BASIS_RANK[binding.basis], binding.window.last_ns, key)
                if best is None or rank > best:
                    best = rank
            if best is not None:
                chosen[text] = machine_ids[best[2]]
        return chosen

    def _roll_up_traffic(self, bound: dict[str, str]) -> None:
        """Sum each address's edges into its own totals.

        Only l3 edges contribute: they are the ones that terminate on an
        address. l2 edges connect machines and have no address to roll into,
        which is a gap in the schema rather than in this code.
        """
        del bound  # traffic is per address; the machine roll-up happens later
        for edge in self._edges.values():
            if edge.layer != "l3":
                continue
            first, second = edge.endpoints
            left = self._addresses.get(first.removeprefix("ip:"))
            right = self._addresses.get(second.removeprefix("ip:"))
            if left is None or right is None:
                continue
            forward = edge.forward.freeze()
            reverse = edge.reverse.freeze()
            left.traffic.add_sent(forward)
            left.traffic.add_received(reverse)
            left.traffic.peers.add(second)
            right.traffic.add_sent(reverse)
            right.traffic.add_received(forward)
            right.traffic.peers.add(first)

    def _build_nodes(
        self,
        localities: dict[str, Locality],
        bound: dict[str, str],
        machine_ids: dict[str, str],
    ) -> list[Node]:
        router_addresses = self._router_addresses(bound, machine_ids)
        nodes: list[Node] = []
        for text, acc in sorted(self._addresses.items()):
            parsed = parse_address(text)
            locality = localities.get(text)
            if parsed is None or locality is None:
                continue
            version: int = parsed.version
            nodes.append(
                Node(
                    id=f"ip:{text}",
                    label=text,
                    node_type=classify_node_type(
                        parsed,
                        is_local=locality.is_local,
                        is_router=text in router_addresses,
                    ),
                    machine_id=bound.get(text),
                    capture_id=self._meta.id,
                    first_seen=self._stamp(acc.window.first_ns),
                    last_seen=self._stamp(acc.window.last_ns),
                    properties=AddressProperties(
                        address=text,
                        version=4 if version == 4 else 6,
                        scope=scope_of(parsed),
                        is_local=locality.is_local,
                        hostnames=_hostnames(acc.hostnames),
                        traffic=acc.traffic.freeze(),
                    ),
                    inference=AddressInference(
                        is_local_basis=locality.basis,
                        machine_bindings=[
                            MachineBinding(
                                machine_id=machine_ids[key],
                                basis=binding.basis,
                                confidence=_BASIS_CONFIDENCE[binding.basis],
                                first_seen=self._stamp(binding.window.first_ns),
                                last_seen=self._stamp(binding.window.last_ns),
                            )
                            for key, binding in sorted(
                                acc.bindings.items(),
                                key=lambda item: -_BASIS_RANK[item[1].basis],
                            )
                        ],
                    ),
                )
            )
        return nodes

    def _router_addresses(self, bound: dict[str, str], machine_ids: dict[str, str]) -> set[str]:
        """Addresses belonging to a machine identified as a router."""
        router_ids = {
            machine_ids[key]
            for key, machine in self._machines.items()
            if machine.mac in self._router_macs
        }
        return {text for text, machine_id in bound.items() if machine_id in router_ids}

    def _build_machines(
        self,
        machine_ids: dict[str, str],
        bound: dict[str, str],
        localities: dict[str, Locality],
    ) -> list[Machine]:
        by_id: dict[str, list[str]] = {}
        for text, machine_id in bound.items():
            by_id.setdefault(machine_id, []).append(text)

        machines: list[Machine] = []
        for key, acc in sorted(self._machines.items(), key=lambda item: machine_ids[item[0]]):
            machine_id = machine_ids[key]
            addresses = sorted(by_id.get(machine_id, []))
            traffic = TrafficAcc()
            hostnames: dict[tuple[str, str], None] = {}
            for text in addresses:
                address = self._addresses.get(text)
                if address is None:
                    continue
                traffic.merge(address.traffic)
                hostnames.update(address.hostnames)

            randomized = mac_is_randomized(acc.mac)
            is_local = any(localities[text].is_local for text in addresses if text in localities)
            machines.append(
                Machine(
                    id=machine_id,
                    # A group MAC is a destination, not a device -- but the
                    # schema gives Machine no node_type, so there is nowhere to
                    # say so beyond the label. Emitting it anyway is the lesser
                    # evil: dropping it would leave every broadcast l2 edge
                    # pointing at an id the document does not carry. Recorded as
                    # a finding in backend/README.md.
                    label=_machine_label(acc.mac, hostnames, addresses),
                    capture_id=self._meta.id,
                    first_seen=self._stamp(acc.window.first_ns),
                    last_seen=self._stamp(acc.window.last_ns),
                    node_ids=[f"ip:{text}" for text in addresses],
                    properties=MachineProperties(
                        mac_address=acc.mac,
                        mac_is_randomized=randomized,
                        # A randomized MAC identifies an association rather than
                        # a device, so there is no manufacturer behind it.
                        oui=oui_of(acc.mac),
                        vendor=None if randomized else acc.vendor,
                        vlan_id=acc.vlan_id,
                        is_local=is_local or not addresses,
                        hostnames=_hostnames(hostnames),
                        traffic=traffic.freeze(),
                    ),
                    inference=MachineInference(
                        hostname_confidence=_best_hostname_confidence(hostnames)
                    ),
                )
            )
        return machines

    def _build_edges(self) -> list[Edge]:
        edges: list[Edge] = []
        for edge_id, acc in sorted(self._edges.items()):
            services = [
                Service(
                    port=service.port,
                    transport=_as_transport(service.transport),
                    l7_protocols=sorted(service.l7_protocols),
                    packets=service.packets,
                    frame_bytes=service.frame_bytes,
                    flow_count=len(service.flows),
                )
                for _, service in sorted(acc.services.items())
            ]
            edges.append(
                Edge(
                    id=edge_id,
                    layer="l3" if acc.layer == "l3" else "l2",
                    endpoints=[acc.endpoints[0], acc.endpoints[1]],
                    capture_id=self._meta.id,
                    first_seen=self._stamp(acc.window.first_ns),
                    last_seen=self._stamp(acc.window.last_ns),
                    properties=EdgeProperties(
                        # An l2 edge has no 5-tuple, so it has no flows to
                        # count rather than a made-up count of one.
                        flow_count=len(acc.flows),
                        forward=acc.forward.freeze(),
                        reverse=acc.reverse.freeze(),
                        services=services,
                        tcp_health=acc.health.freeze(),
                    ),
                )
            )
        return edges

    def _build_capture(self, packet_count: int) -> Capture:
        window = self._window or Window.at(0)
        return Capture(
            id=self._meta.id,
            filename=self._meta.filename,
            sha256=self._meta.sha256,
            interface=self._meta.interface,
            snaplen=self._meta.snaplen,
            started_at=self._stamp(window.first_ns),
            ended_at=self._stamp(window.last_ns),
            packets_total=packet_count,
            packets_dropped=self._meta.packets_dropped,
        )

    def _stamp(self, epoch_ns: int) -> str:
        return format_rfc3339(epoch_ns, digits=self._meta.timestamp_digits)


def _vlan_of(record: PacketRecord) -> int | None:
    """The VLAN this frame belongs to, or None when it carries none.

    802.1Q with VID 0 is a *priority* tag: it asserts a priority and claims no
    VLAN membership. Reading it as VLAN 0 splits one host into two machines,
    one per tag, which is the address fragmentation the machine model exists to
    prevent.
    """
    return record.vlan_id or None


def _machine_key(mac: str, vlan_id: int | None) -> str:
    """The identity of a machine: MAC *and* VLAN, per README.md.

    The same MAC on two VLANs is two attachments to two networks, and so two
    machines.
    """
    return f"{mac}|{vlan_id if vlan_id is not None else ''}"


def _edge_id(endpoints: tuple[str, str]) -> str:
    """Derived from the sorted pair, so one conversation has one id.

    Only the namespace colon is replaced, which keeps an IPv6 address readable
    and matches the frontend's derivation exactly.
    """
    first, second = endpoints
    return f"edge_{first.replace(':', '-', 1)}_{second.replace(':', '-', 1)}"


def _hostnames(claims: dict[tuple[str, str], None]) -> list[Hostname]:
    """Every name observed, deduplicated. Sources routinely disagree; all stay."""
    return [
        Hostname(name=name, source=_as_hostname_source(source)) for name, source in sorted(claims)
    ]


def _best_hostname_confidence(claims: dict[tuple[str, str], None]) -> float | None:
    if not claims:
        return None
    return max(_HOSTNAME_CONFIDENCE.get(source, 0.5) for _, source in claims)


#: Well-known group MACs, named rather than left as hex.
_GROUP_MAC_LABELS: dict[str, str] = {
    "ff:ff:ff:ff:ff:ff": "broadcast",
    "01:80:c2:00:00:00": "STP bridge group",
    "01:00:0c:cc:cc:cc": "Cisco CDP/VTP",
    "01:80:c2:00:00:0e": "LLDP multicast",
}


def _machine_label(mac: str, hostnames: dict[tuple[str, str], None], addresses: list[str]) -> str:
    """Name the circle: a hostname if one was observed, else something honest.

    Falls back to an address and then to the MAC rather than inventing a name,
    so a label is never mistaken for identification that did not happen.
    """
    if is_group_mac(mac):
        known = _GROUP_MAC_LABELS.get(mac)
        if known is not None:
            return known
        return "IPv4 multicast" if mac.startswith("01:00:5e") else f"multicast {mac}"
    if hostnames:
        best = min(
            hostnames,
            key=lambda item: (-_HOSTNAME_CONFIDENCE.get(item[1], 0.5), item[0]),
        )
        return best[0]
    if addresses:
        return addresses[0]
    return mac


def _as_transport(value: str | None) -> str:
    return value if value in {"tcp", "udp", "icmp"} else "tcp"


def _as_hostname_source(value: str) -> str:
    return value
