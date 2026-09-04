# Network Graph

Turns a Wireshark capture into an interactive map of who talked to whom.

Every node is a computer, keyed by the network card it was seen on and listing
every address it answered at. Every edge is the traffic exchanged between a pair
of machines over the capture.

## Schemas

Node (computer) schema:

```json
{
  "id": "00:1A:2B:3C:4D:5E",          // Primary key (MAC address preferred for local, IP for remote)
  "label": "192.168.1.50",            // Display label (IP, Hostname, or MAC)
  "properties": {
    "mac_address": "00:1A:2B:3C:4D:5E",
    "ip_addresses": ["192.168.1.50"], // List to handle IP changes over time
    "hostname": "workstation-01.local", // Resolved via DNS / NBNS / mDNS
    "vendor": "Intel Corporate",       // OUI lookup from MAC prefix
    "is_local": true
  }
}
```

Edge (traffic) schema:

```json
{
  "id": "edge_001A2B3C4D5E_88F7C7123456", // Unique edge ID
  "source": "00:1A:2B:3C:4D:5E",          // Sender node ID
  "target": "88:F7:C7:12:34:56",          // Receiver node ID
  "properties": {
    "protocol_summary": ["TCP", "TLSv1.3", "HTTP"], // Protocols detected
    "ports": [80, 443, 8080],                       // Destination ports used
    "packet_count": 1420,                           // Total packets transferred
    "total_bytes": 1048576,                         // Traffic volume in bytes
    "first_seen": "2026-09-04T17:30:00Z",
    "last_seen": "2026-09-04T17:38:00Z"
  }
}
```
