"""A direct transcription of the schema in README.md.

This is what FastAPI serialises, and ``frontend/src/types/graph.ts`` is the same
contract in the other language. The two change in the same commit.

Python is the lucky side: the schema is already snake_case, so there is no alias
layer and no translation. ``frame_bytes`` stays ``frame_bytes``.

Every model is frozen. These are a result, not a workspace -- aggregation
accumulates into the mutable objects in ``app.aggregation.accumulators`` and
constructs one of these once, at the end.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

type NodeType = Literal["host", "router", "broadcast", "multicast", "external"]
type Layer = Literal["l3", "l2"]
type Transport = Literal["tcp", "udp", "icmp"]
type AddressScope = Literal["private", "public", "link_local", "loopback", "multicast"]
type HostnameSource = Literal["dns_ptr", "mdns", "nbns", "dhcp_option_12", "tls_sni", "http_host"]
type BindingBasis = Literal["arp_reply", "ndp_advertisement", "dhcp_ack", "source_mac"]

type Count = Annotated[int, Field(ge=0)]
type Confidence = Annotated[float, Field(ge=0, le=1)]

# RFC 3339, UTC, with fractional seconds at the capture's native resolution.
# Carried as a string rather than a datetime on purpose: Python's datetime is
# microsecond-precision, so a nanosecond pcapng would silently lose three digits
# by passing through one. See app.parsing.timestamps.
type Timestamp = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$")]


class Frozen(BaseModel):
    """Forbid unknown fields and refuse mutation.

    ``extra="forbid"`` is the load-bearing half: a typo in a field name must
    fail loudly here rather than round-trip into a document the frontend then
    silently ignores.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


class Counters(Frozen):
    packets: Count
    # On the wire, including L2 headers.
    frame_bytes: Count
    # L4 payload only. Never derived from frame_bytes, and never summed with it.
    payload_bytes: Count


class Traffic(Frozen):
    packets_sent: Count
    packets_received: Count
    frame_bytes_sent: Count
    frame_bytes_received: Count
    peer_count: Count


class Hostname(Frozen):
    name: str
    source: HostnameSource


class Capture(Frozen):
    id: str
    filename: str
    sha256: str
    interface: str
    snaplen: Count
    started_at: Timestamp
    ended_at: Timestamp
    packets_total: Count
    packets_dropped: Count


class MachineBinding(Frozen):
    """One observed address-to-machine binding, with the evidence behind it."""

    machine_id: str
    basis: BindingBasis
    confidence: Confidence
    first_seen: Timestamp
    last_seen: Timestamp


class MachineProperties(Frozen):
    mac_address: str
    mac_is_randomized: bool
    # Inferred, and meaningless when the MAC is randomized -- then both are None.
    oui: str | None
    vendor: str | None
    # Part of the machine key, not a list. Same MAC, different VLAN, different machine.
    vlan_id: int | None
    is_local: bool
    hostnames: list[Hostname]
    # The sum of this machine's nodes.
    traffic: Traffic


class MachineInference(Frozen):
    hostname_confidence: Confidence | None = None


class Machine(Frozen):
    id: str
    label: str
    capture_id: str
    first_seen: Timestamp
    last_seen: Timestamp
    # May be empty: a host that only ever spoke ARP has a MAC and no address.
    node_ids: list[str]
    properties: MachineProperties
    inference: MachineInference | None = None


class AddressProperties(Frozen):
    address: str
    version: Literal[4, 6]
    scope: AddressScope
    is_local: bool
    hostnames: list[Hostname]
    # The sum of this node's edges. What the sqrt-area circle sizing reads.
    traffic: Traffic


class AddressInference(Frozen):
    is_local_basis: str | None = None
    # Every binding observed, with its time range. More than one entry is not an
    # error to resolve by picking a winner -- it is DHCP reassignment, MAC
    # randomization, or spoofing, and all three are worth seeing. Node.machine_id
    # names the one in effect; this list is the evidence.
    machine_bindings: list[MachineBinding] = Field(default_factory=list)


class Node(Frozen):
    id: str
    label: str
    node_type: NodeType
    # The binding in effect, or None. None is the normal case past the gateway:
    # every frame for a remote address carries the router's MAC, so there is no
    # hardware address to attribute to it.
    machine_id: str | None
    capture_id: str
    first_seen: Timestamp
    last_seen: Timestamp
    properties: AddressProperties
    inference: AddressInference | None = None


class Service(Frozen):
    # The server-side port, chosen per flow.
    port: int
    # Disambiguates: TCP/53 and UDP/53 are different services.
    transport: Transport
    l7_protocols: list[str]
    packets: Count
    frame_bytes: Count
    flow_count: Count


class TcpHealth(Frozen):
    syn_count: Count
    syn_ack_count: Count
    reset_count: Count
    retransmission_count: Count
    failed_handshakes: Count


class EdgeProperties(Frozen):
    # Distinct 5-tuples. Never approximated by a packet count.
    flow_count: Count
    # endpoints[0] -> endpoints[1].
    forward: Counters
    # endpoints[1] -> endpoints[0].
    reverse: Counters
    services: list[Service]
    tcp_health: TcpHealth | None = None


class Edge(Frozen):
    id: str
    # l3 connects "ip:" nodes; l2 connects "mac:" machines. Never mixed.
    layer: Layer
    directed: Literal[False] = False
    # Sorted, so a pair produces the same edge and the same id regardless of
    # who spoke first.
    endpoints: Annotated[list[str], Field(min_length=2, max_length=2)]
    capture_id: str
    first_seen: Timestamp
    last_seen: Timestamp
    properties: EdgeProperties


class CaptureDocument(Frozen):
    schema_version: Literal["2.0"] = "2.0"
    capture: Capture
    machines: list[Machine]
    nodes: list[Node]
    edges: list[Edge]
