// A direct transcription of the schema in README.md. When the schema changes,
// this file changes in the same commit.
//
// Wire field names are kept exactly as the schema spells them -- frame_bytes,
// packets_sent, mac_is_randomized. Nothing is camelCased on the way in, so a
// bug report never has to be translated between two vocabularies and the
// schema doc stays greppable against the code.

/** A machine: one physical host, keyed by the MAC it was seen at. */
export type MachineId = `mac:${string}`

/** A node: one address. This is what edges connect and what sub-circles draw. */
export type AddressId = `ip:${string}`

export type NodeId = MachineId | AddressId

export type EdgeId = `edge_${string}`

// Edges terminate on addresses. A MachineId here is a type error, not a
// runtime check, which is the whole point of splitting the two: every packet
// headed off the segment is L2-addressed to the router, so attributing L3
// conversations to MACs would collapse the entire internet onto the gateway.
export type EdgeEndpoints = readonly [AddressId, AddressId]

export type NodeType = 'host' | 'router' | 'broadcast' | 'multicast' | 'external'
export type Layer = 'l3' | 'l2'
export type Transport = 'tcp' | 'udp' | 'icmp'
export type AddressScope = 'private' | 'public' | 'link_local' | 'loopback' | 'multicast'

export type HostnameSource =
  | 'dns_ptr'
  | 'mdns'
  | 'nbns'
  | 'dhcp_option_12'
  | 'tls_sni'
  | 'http_host'

/** Strongest first, per README.md. */
export type BindingBasis = 'arp_reply' | 'ndp_advertisement' | 'dhcp_ack' | 'source_mac'

/** RFC 3339 with fractional seconds, UTC, at the capture's native resolution. */
export type Timestamp = string

export interface Counters {
  packets: number
  frame_bytes: number
  payload_bytes: number
}

export interface Traffic {
  packets_sent: number
  packets_received: number
  frame_bytes_sent: number
  frame_bytes_received: number
  peer_count: number
}

export interface Hostname {
  name: string
  source: HostnameSource
}

export interface Capture {
  id: string
  filename: string
  sha256: string
  interface: string
  snaplen: number
  started_at: Timestamp
  ended_at: Timestamp
  packets_total: number
  packets_dropped: number
}

export interface MachineProperties {
  mac_address: string
  /** From the locally-administered bit. When true, `vendor` is meaningless. */
  mac_is_randomized: boolean
  /** Inferred, and absent when the MAC is randomized. */
  oui: string | null
  /** Inferred, and absent when the MAC is randomized. */
  vendor: string | null
  /** Part of the machine key, not a list. Same MAC, different VLAN, different machine. */
  vlan_id: number | null
  is_local: boolean
  hostnames: readonly Hostname[]
  /** The sum of this machine's nodes. */
  traffic: Traffic
}

export interface MachineInference {
  hostname_confidence?: number
}

export interface Machine {
  id: MachineId
  label: string
  capture_id: string
  first_seen: Timestamp
  last_seen: Timestamp
  /** May be empty: a host that only ever spoke ARP has a MAC and no address. */
  node_ids: readonly AddressId[]
  properties: MachineProperties
  inference?: MachineInference
}

export interface MachineBinding {
  machine_id: MachineId
  basis: BindingBasis
  confidence: number
  first_seen: Timestamp
  last_seen: Timestamp
}

export interface AddressProperties {
  address: string
  version: 4 | 6
  scope: AddressScope
  is_local: boolean
  hostnames: readonly Hostname[]
  /** The sum of this node's edges. This is what the sqrt-area sizing reads. */
  traffic: Traffic
}

export interface AddressInference {
  is_local_basis?: string
  /**
   * Every binding observed, with its time range. More than one entry is not an
   * error to resolve by picking a winner -- it is DHCP reassignment, MAC
   * randomization, or spoofing, and all three are worth seeing.
   */
  machine_bindings?: readonly MachineBinding[]
}

export interface GraphNode {
  id: AddressId
  label: string
  node_type: NodeType
  /**
   * Null is the normal case past the gateway: every frame for a remote address
   * carries the router's MAC, so there is no hardware address to attribute.
   */
  machine_id: MachineId | null
  capture_id: string
  first_seen: Timestamp
  last_seen: Timestamp
  properties: AddressProperties
  inference?: AddressInference
}

export interface Service {
  /** The server-side port, chosen per flow. */
  port: number
  transport: Transport
  l7_protocols: readonly string[]
  packets: number
  frame_bytes: number
  flow_count: number
}

export interface TcpHealth {
  syn_count: number
  syn_ack_count: number
  reset_count: number
  retransmission_count: number
  failed_handshakes: number
}

export interface EdgeProperties {
  /** Distinct 5-tuples. Not approximated by a packet count. */
  flow_count: number
  /** endpoints[0] -> endpoints[1]. */
  forward: Counters
  /** endpoints[1] -> endpoints[0]. */
  reverse: Counters
  services: readonly Service[]
  tcp_health: TcpHealth | null
}

export interface GraphEdge {
  id: EdgeId
  layer: Layer
  directed: false
  /** Sorted, so a pair always produces the same edge and the same id. */
  endpoints: EdgeEndpoints
  capture_id: string
  first_seen: Timestamp
  last_seen: Timestamp
  properties: EdgeProperties
}

export interface CaptureDocument {
  schema_version: string
  capture: Capture
  machines: readonly Machine[]
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
}

/** What is currently selected. Never two loose optional fields. */
export type Selection =
  | { kind: 'machine'; id: MachineId }
  | { kind: 'node'; id: AddressId }
  | { kind: 'edge'; id: EdgeId }
  | null
