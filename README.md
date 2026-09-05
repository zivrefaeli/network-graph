# Network Graph

Turns a Wireshark capture into an interactive map of who talked to whom.

A machine is one circle. The addresses it answered to sit inside that circle,
and conversations attach to the address that carried them — so a PC with a LAN
address and a VPN address is one machine with two sub-circles, each wired to its
own peers, rather than two unrelated dots that happen to be the same computer.

## Schemas

### Conventions

These hold across every document the tool emits:

- **There are two kinds of graph element.** A **machine** is a physical host,
  keyed by the MAC it was seen at. A **node** is a single address, keyed by that
  address. Nodes are what edges connect; machines only group them.
- **IDs are namespaced** — `mac:00:1a:2b:3c:4d:5e`, `ip:10.20.30.50`. MACs are
  lowercase and colon-separated; IPv6 is written in RFC 5952 canonical form.
- **A machine is keyed by MAC *and* VLAN.** The same MAC seen on two VLANs is
  two machines, because it is two attachments to two networks.
- **`l3` edges connect `ip:` nodes. `l2` edges connect `mac:` machines.** An
  `l3` edge that terminates on a MAC is always a bug: every packet headed off
  the segment is L2-addressed to the router, so attributing L3 conversations to
  MACs collapses the entire internet onto the gateway. Traffic with no IP header
  at all (ARP, STP, LLDP) has no address to attach to and is the only thing that
  may be an `l2` edge.
- **An address joins a machine only on source-side evidence.** The destination
  MAC of a frame is routinely the gateway's, so binding on it would attribute
  half the internet to the router. Bindings are recorded with their basis and
  time range, and an address seen at two MACs keeps both.
- **Edges are undirected conversations** between a sorted endpoint pair, with
  per-direction counters inside. `forward` means `endpoints[0] → endpoints[1]`;
  `reverse` is the opposite.
- **Counters are named `packets`, `frame_bytes`, and `payload_bytes`.**
  `frame_bytes` is on-the-wire size including L2 headers; `payload_bytes` is L4
  payload only.
- **Traffic rolls up.** A node's `traffic` is the sum of its edges' counters; a
  machine's is the sum of its nodes'. Both levels are derivable, and both are
  emitted so a renderer can size a circle without walking the edge list.
- **Timestamps are RFC 3339 with fractional seconds**, UTC, preserving the
  capture's native resolution.
- **Inferred fields are marked.** Hostnames, vendors, locality, machine
  membership and `node_type` are all guesses; anything derived carries its basis
  or a confidence score.

### Document

```json
{
  "schema_version": "2.0",
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
  "machines": [],
  "nodes": [],
  "edges": []
}
```

`capture.id` is stamped onto every machine, node and edge so several captures
can be merged into one graph later without losing provenance.

### Machine

One physical host. Rendered as the outer circle; it is a container, not a
conversation endpoint.

```json
{
  "id": "mac:00:1a:2b:3c:4d:5e",
  "label": "workstation-01",
  "capture_id": "cap_7f3a9c",
  "first_seen": "2026-09-04T17:30:01.482913Z",
  "last_seen": "2026-09-04T17:37:58.104772Z",
  "node_ids": ["ip:10.20.30.50", "ip:10.10.0.6"],
  "properties": {
    "mac_address": "00:1a:2b:3c:4d:5e",
    "mac_is_randomized": false,
    "oui": "00:1a:2b",
    "vendor": "Intel Corporate",
    "vlan_id": 10,
    "is_local": true,
    "hostnames": [
      { "name": "workstation-01.local", "source": "mdns" },
      { "name": "workstation-01", "source": "dhcp_option_12" }
    ],
    "traffic": {
      "packets_sent": 17384,
      "packets_received": 36808,
      "frame_bytes_sent": 1953840,
      "frame_bytes_received": 48770540,
      "peer_count": 5
    }
  },
  "inference": {
    "hostname_confidence": 0.9
  }
}
```

| Field | Notes |
| --- | --- |
| `node_ids` | Every address bound to this machine. May be empty — a host that only ever spoke ARP has a MAC and no address. |
| `mac_is_randomized` | Set from the locally-administered bit of the first octet. When true the MAC identifies one association rather than a device, `vendor` is meaningless, and a device that rotates its MAC mid-capture legitimately appears as two machines. |
| `vlan_id` | Part of the key, not a list. Same MAC, different VLAN, different machine. |
| `hostnames` | Collected across all of the machine's addresses. Sources routinely disagree; all of them are kept. |
| `traffic` | The sum of this machine's nodes. `peer_count` counts distinct peer *addresses* across every node, deduplicated. |

### Node (address)

One address. This is what an edge connects to, and what a sub-circle draws.

```json
{
  "id": "ip:10.20.30.50",
  "label": "10.20.30.50",
  "node_type": "host",
  "machine_id": "mac:00:1a:2b:3c:4d:5e",
  "capture_id": "cap_7f3a9c",
  "first_seen": "2026-09-04T17:30:01.482913Z",
  "last_seen": "2026-09-04T17:37:58.104772Z",
  "properties": {
    "address": "10.20.30.50",
    "version": 4,
    "scope": "private",
    "is_local": true,
    "hostnames": [{ "name": "workstation-01.local", "source": "mdns" }],
    "traffic": {
      "packets_sent": 13334,
      "packets_received": 28178,
      "frame_bytes_sent": 1438740,
      "frame_bytes_received": 38249940,
      "peer_count": 4
    }
  },
  "inference": {
    "is_local_basis": "rfc1918_and_same_l2_segment",
    "machine_bindings": [
      {
        "machine_id": "mac:00:1a:2b:3c:4d:5e",
        "basis": "arp_reply",
        "confidence": 0.98,
        "first_seen": "2026-09-04T17:30:01.482913Z",
        "last_seen": "2026-09-04T17:37:58.104772Z"
      }
    ]
  }
}
```

| Field | Notes |
| --- | --- |
| `node_type` | `host`, `router`, `broadcast`, `multicast`, or `external`. Keeps multicast groups from rendering as machines. |
| `machine_id` | The binding in effect, or `null`. Null is the normal case for anything past the gateway — every frame for a remote address carries the router's MAC, so there is no hardware address to attribute to it. Such a node draws as a plain circle with no container. |
| `scope` | `private`, `public`, `link_local`, `loopback`, or `multicast`. |
| `inference.machine_bindings` | Every binding observed, with its time range. More than one entry is not an error to resolve by picking a winner — it is DHCP reassignment, MAC randomization, or spoofing, and all three are worth seeing. `machine_id` names the one in effect; the array is the evidence. |
| `basis` | `arp_reply`, `ndp_advertisement`, `dhcp_ack`, or `source_mac`. Listed strongest first. |
| `traffic` | The sum of this node's edges. This is the level the √-area circle sizing reads from. |

### Edge (conversation)

```json
{
  "id": "edge_ip-10.20.30.50_ip-96.7.128.175",
  "layer": "l3",
  "directed": false,
  "endpoints": ["ip:10.20.30.50", "ip:96.7.128.175"],
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
| `layer` | `l3` for IP conversations between `ip:` nodes, `l2` for frame-level traffic between `mac:` machines. Endpoint IDs are namespaced accordingly, and the two are never mixed within one edge. |
| `endpoints` | Sorted, so a pair always produces the same edge and the same `id` regardless of who spoke first. Both endpoints may belong to the same machine — a host talking to itself across two of its own addresses is a real thing and draws as a line inside one circle. |
| `flow_count` | Distinct 5-tuples. One long TLS session and five thousand short connections carry similar byte counts but very different `flow_count`. |
| `services[].port` | The server-side port, chosen per flow. `transport` disambiguates — TCP/53 and UDP/53 are different services. |
| `tcp_health` | What separates a conversation from a scan. Many SYNs with no SYN/ACKs, or a high reset count, is the shape worth surfacing in the UI. |
