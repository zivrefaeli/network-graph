# Network Graph

Turns a Wireshark capture into an interactive map of who talked to whom.

Every node is a machine, keyed by the address it was seen at and carrying every
other address, name, and hardware detail it revealed during the capture. Every
edge is the traffic exchanged between a pair of machines.

## Schemas

### Conventions

These hold across every document the tool emits:

- **The graph is L3 by default.** Nodes are keyed by IP; the MAC a host was seen
  at is a property, not the key. Traffic that has no L3 addressing (ARP, STP,
  LLDP) is emitted as an `l2` edge between MAC-keyed nodes. Every edge states its
  `layer` so the two are never conflated.
- **IDs are namespaced** — `ip:192.168.1.50`, `mac:00:1a:2b:3c:4d:5e`. MACs are
  lowercase and colon-separated; IPv6 is written in RFC 5952 canonical form.
- **Edges are undirected conversations** between a sorted endpoint pair, with
  per-direction counters inside. `forward` means `endpoints[0] → endpoints[1]`;
  `reverse` is the opposite.
- **Counters are named `packets`, `frame_bytes`, and `payload_bytes`.**
  `frame_bytes` is on-the-wire size including L2 headers; `payload_bytes` is L4
  payload only.
- **Timestamps are RFC 3339 with fractional seconds**, UTC, preserving the
  capture's native resolution.
- **Inferred fields are marked.** Hostnames, vendors, and locality are guesses;
  anything derived carries its basis or a confidence score.

### Document

```json
{
  "schema_version": "1.0",
  "capture": {
    "id": "cap_7f3a9c",
    "filename": "office-2026-09-04.pcapng",
    "sha256": "9b74c9897bac770ffc029102a8b4af54d11fe0...",
    "interface": "en0",
    "snaplen": 262144,
    "started_at": "2026-09-04T17:30:00.000000Z",
    "ended_at": "2026-09-04T17:38:00.000000Z",
    "packets_total": 184203,
    "packets_dropped": 0
  },
  "nodes": [],
  "edges": []
}
```

`capture.id` is stamped onto every node and edge so several captures can be
merged into one graph later without losing provenance.

### Node (machine)

```json
{
  "id": "ip:192.168.1.50",
  "label": "workstation-01",
  "node_type": "host",
  "capture_id": "cap_7f3a9c",
  "first_seen": "2026-09-04T17:30:01.482913Z",
  "last_seen": "2026-09-04T17:37:58.104772Z",
  "properties": {
    "mac_address": "00:1a:2b:3c:4d:5e",
    "mac_is_randomized": false,
    "oui": "00:1a:2b",
    "vendor": "Intel Corporate",
    "vlan_ids": [10],
    "is_local": true,
    "addresses": [
      {
        "address": "192.168.1.50",
        "version": 4,
        "scope": "private",
        "first_seen": "2026-09-04T17:30:01.482913Z",
        "last_seen": "2026-09-04T17:37:58.104772Z"
      },
      {
        "address": "fe80::21a:2bff:fe3c:4d5e",
        "version": 6,
        "scope": "link_local",
        "first_seen": "2026-09-04T17:30:02.001220Z",
        "last_seen": "2026-09-04T17:37:55.882301Z"
      }
    ],
    "hostnames": [
      { "name": "workstation-01.local", "source": "mdns" },
      { "name": "workstation-01", "source": "dhcp_option_12" }
    ],
    "traffic": {
      "packets_sent": 41022,
      "packets_received": 38915,
      "frame_bytes_sent": 8104233,
      "frame_bytes_received": 40113998,
      "peer_count": 17
    }
  },
  "inference": {
    "hostname_confidence": 0.9,
    "is_local_basis": "rfc1918_and_same_l2_segment"
  }
}
```

| Field | Notes |
| --- | --- |
| `node_type` | `host`, `router`, `broadcast`, `multicast`, or `external`. Keeps `ff:ff:ff:ff:ff:ff` and multicast groups from rendering as machines. |
| `mac_is_randomized` | Set from the locally-administered bit of the first octet. When true, the MAC identifies a session, not a device, and `vendor` is meaningless. |
| `vlan_ids` | Every VLAN the node was observed on. The same MAC on two VLANs is two nodes. |
| `addresses[].scope` | `private`, `public`, `link_local`, `loopback`, or `multicast`. |
| `hostnames[].source` | `dns_ptr`, `mdns`, `nbns`, `dhcp_option_12`, `tls_sni`, or `http_host`. Sources routinely disagree; all of them are kept. |
| `traffic` | Pre-aggregated so the renderer can size nodes without walking the edge list. |

### Edge (conversation)

```json
{
  "id": "edge_ip-192.168.1.50_ip-93.184.216.34",
  "layer": "l3",
  "directed": false,
  "endpoints": ["ip:192.168.1.50", "ip:93.184.216.34"],
  "capture_id": "cap_7f3a9c",
  "first_seen": "2026-09-04T17:30:04.221904Z",
  "last_seen": "2026-09-04T17:37:41.339820Z",
  "properties": {
    "flow_count": 12,
    "forward": { "packets": 820, "frame_bytes": 98400, "payload_bytes": 41200 },
    "reverse": { "packets": 600, "frame_bytes": 950176, "payload_bytes": 902311 },
    "services": [
      {
        "port": 443,
        "transport": "tcp",
        "l7_protocols": ["tls", "http2"],
        "packets": 1380,
        "frame_bytes": 1041300,
        "flow_count": 11
      },
      {
        "port": 80,
        "transport": "tcp",
        "l7_protocols": ["http"],
        "packets": 40,
        "frame_bytes": 7276,
        "flow_count": 1
      }
    ],
    "tcp_health": {
      "syn_count": 12,
      "syn_ack_count": 12,
      "reset_count": 1,
      "retransmission_count": 3,
      "failed_handshakes": 0
    }
  }
}
```

| Field | Notes |
| --- | --- |
| `layer` | `l3` for IP conversations, `l2` for frame-level traffic with no IP header. Endpoint IDs are namespaced accordingly. |
| `endpoints` | Sorted, so a pair always produces the same edge and the same `id` regardless of who spoke first. |
| `flow_count` | Distinct 5-tuples. One long TLS session and five thousand short connections carry similar byte counts but very different `flow_count`. |
| `services[].port` | The server-side port, chosen per flow. `transport` disambiguates — TCP/53 and UDP/53 are different services. |
| `tcp_health` | What separates a conversation from a scan. Many SYNs with no SYN/ACKs, or a high reset count, is the shape worth surfacing in the UI. |
