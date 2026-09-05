import type { CaptureDocument } from '@/types/graph'

/**
 * A hand-built capture document in the shape defined by README.md.
 *
 * This is the mock the app renders until a real one is uploaded. It lives
 * under api/ rather than beside the components because that is what it
 * stands in for: the document the backend will return in stage 3. Swapping
 * it for a fetch should touch this directory and nothing else.
 *
 * Four machines and seven addresses. `workstation-01` is the point of the
 * example: one physical PC holding both a LAN address and a VPN address, drawn
 * as one circle with two sub-circles, each wired to its own peers.
 *
 * The numbers are internally consistent. Every node's `traffic` is the sum of
 * its edges' per-direction counters, and every machine's is the sum of its
 * nodes', so circle sizes and line weights agree with what the panel prints.
 *
 * Note what the L3 rule buys: traffic bound for the internet is a conversation
 * with the remote address, not with the gateway. The gateway is a modest circle
 * carrying DNS and DHCP rather than a false hub with everyone's bytes on it.
 */

const CAPTURE_ID = 'cap_7f3a9c'

export const sampleCapture: CaptureDocument = {
  schema_version: '2.0',
  capture: {
    id: CAPTURE_ID,
    filename: 'office-2026-09-04.pcapng',
    sha256: '9b74c9897bac770ffc029102a8b4af54d11fe0a3c5d81b6e4f2907ad3c1e5b8f2',
    interface: 'en0',
    snaplen: 262144,
    started_at: '2026-09-04T17:30:00.000000Z',
    ended_at: '2026-09-04T17:38:00.000000Z',
    packets_total: 184203,
    packets_dropped: 0,
  },

  machines: [
    {
      // Two addresses, so this one renders as a container with sub-circles.
      id: 'mac:00:1a:2b:3c:4d:5e',
      label: 'workstation-01',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:01.482913Z',
      last_seen: '2026-09-04T17:37:58.104772Z',
      node_ids: ['ip:10.20.30.50', 'ip:10.10.0.6'],
      properties: {
        mac_address: '00:1a:2b:3c:4d:5e',
        mac_is_randomized: false,
        oui: '00:1a:2b',
        vendor: 'Intel Corporate',
        vlan_id: 10,
        is_local: true,
        hostnames: [
          { name: 'workstation-01.local', source: 'mdns' },
          { name: 'workstation-01', source: 'dhcp_option_12' },
        ],
        traffic: {
          packets_sent: 17384,
          packets_received: 36808,
          frame_bytes_sent: 1953840,
          frame_bytes_received: 48770540,
          peer_count: 5,
        },
      },
      inference: { hostname_confidence: 0.9 },
    },

    {
      id: 'mac:c8:d7:19:04:aa:31',
      label: 'gateway',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:00.104882Z',
      last_seen: '2026-09-04T17:37:59.918204Z',
      node_ids: ['ip:10.20.30.1'],
      properties: {
        mac_address: 'c8:d7:19:04:aa:31',
        mac_is_randomized: false,
        oui: 'c8:d7:19',
        vendor: 'Ubiquiti Networks',
        vlan_id: 10,
        is_local: true,
        hostnames: [
          { name: 'gateway.local', source: 'mdns' },
          { name: 'router.lan', source: 'dns_ptr' },
        ],
        traffic: {
          packets_sent: 2640,
          packets_received: 2720,
          frame_bytes_sent: 338720,
          frame_bytes_received: 663520,
          peer_count: 3,
        },
      },
      inference: { hostname_confidence: 0.95 },
    },

    {
      id: 'mac:00:11:32:8a:c4:7d',
      label: 'nas-01',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:03.771204Z',
      last_seen: '2026-09-04T17:37:57.220884Z',
      node_ids: ['ip:10.20.30.20'],
      properties: {
        mac_address: '00:11:32:8a:c4:7d',
        mac_is_randomized: false,
        oui: '00:11:32',
        vendor: 'Synology Incorporated',
        vlan_id: 10,
        is_local: true,
        hostnames: [
          { name: 'nas-01.local', source: 'mdns' },
          { name: 'NAS-01', source: 'nbns' },
        ],
        traffic: {
          packets_sent: 24180,
          packets_received: 9940,
          frame_bytes_sent: 34190220,
          frame_bytes_received: 1092800,
          peer_count: 1,
        },
      },
      inference: { hostname_confidence: 0.9 },
    },

    {
      id: 'mac:6a:3f:11:9d:02:c8',
      label: 'pixel-8',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:12.338001Z',
      last_seen: '2026-09-04T17:37:44.019663Z',
      node_ids: ['ip:10.20.30.77'],
      properties: {
        // Locally-administered bit set on the first octet, so this MAC
        // identifies one association rather than a device. No OUI, no vendor.
        mac_address: '6a:3f:11:9d:02:c8',
        mac_is_randomized: true,
        oui: null,
        vendor: null,
        vlan_id: 10,
        is_local: true,
        hostnames: [{ name: 'Pixel-8', source: 'dhcp_option_12' }],
        traffic: {
          packets_sent: 1138,
          packets_received: 2004,
          frame_bytes_sent: 125400,
          frame_bytes_received: 182960,
          peer_count: 2,
        },
      },
      inference: { hostname_confidence: 0.6 },
    },
  ],

  nodes: [
    {
      id: 'ip:10.20.30.50',
      label: '10.20.30.50',
      node_type: 'host',
      machine_id: 'mac:00:1a:2b:3c:4d:5e',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:01.482913Z',
      last_seen: '2026-09-04T17:37:58.104772Z',
      properties: {
        address: '10.20.30.50',
        version: 4,
        scope: 'private',
        is_local: true,
        hostnames: [{ name: 'workstation-01.local', source: 'mdns' }],
        traffic: {
          packets_sent: 13334,
          packets_received: 28178,
          frame_bytes_sent: 1438740,
          frame_bytes_received: 38249940,
          peer_count: 4,
        },
      },
      inference: {
        is_local_basis: 'rfc1918_and_same_l2_segment',
        machine_bindings: [
          {
            machine_id: 'mac:00:1a:2b:3c:4d:5e',
            basis: 'arp_reply',
            confidence: 0.98,
            first_seen: '2026-09-04T17:30:01.482913Z',
            last_seen: '2026-09-04T17:37:58.104772Z',
          },
        ],
      },
    },

    {
      // Same physical machine, reached over the tunnel. Bound by source MAC:
      // the tunnelled frames still leave the same NIC.
      id: 'ip:10.10.0.6',
      label: '10.10.0.6',
      node_type: 'host',
      machine_id: 'mac:00:1a:2b:3c:4d:5e',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:40.229118Z',
      last_seen: '2026-09-04T17:37:50.660402Z',
      properties: {
        address: '10.10.0.6',
        version: 4,
        scope: 'private',
        is_local: true,
        hostnames: [{ name: 'workstation-01.vpn', source: 'dns_ptr' }],
        traffic: {
          packets_sent: 4050,
          packets_received: 8630,
          frame_bytes_sent: 515100,
          frame_bytes_received: 10520600,
          peer_count: 2,
        },
      },
      inference: {
        is_local_basis: 'rfc1918_and_same_l2_segment',
        machine_bindings: [
          {
            machine_id: 'mac:00:1a:2b:3c:4d:5e',
            basis: 'source_mac',
            confidence: 0.82,
            first_seen: '2026-09-04T17:31:40.229118Z',
            last_seen: '2026-09-04T17:37:50.660402Z',
          },
        ],
      },
    },

    {
      id: 'ip:10.20.30.1',
      label: '10.20.30.1',
      node_type: 'router',
      machine_id: 'mac:c8:d7:19:04:aa:31',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:00.104882Z',
      last_seen: '2026-09-04T17:37:59.918204Z',
      properties: {
        address: '10.20.30.1',
        version: 4,
        scope: 'private',
        is_local: true,
        hostnames: [{ name: 'router.lan', source: 'dns_ptr' }],
        traffic: {
          packets_sent: 2640,
          packets_received: 2720,
          frame_bytes_sent: 338720,
          frame_bytes_received: 663520,
          peer_count: 3,
        },
      },
      inference: {
        is_local_basis: 'rfc1918_and_same_l2_segment',
        machine_bindings: [
          {
            machine_id: 'mac:c8:d7:19:04:aa:31',
            basis: 'arp_reply',
            confidence: 0.99,
            first_seen: '2026-09-04T17:30:00.104882Z',
            last_seen: '2026-09-04T17:37:59.918204Z',
          },
        ],
      },
    },

    {
      id: 'ip:10.20.30.20',
      label: '10.20.30.20',
      node_type: 'host',
      machine_id: 'mac:00:11:32:8a:c4:7d',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:03.771204Z',
      last_seen: '2026-09-04T17:37:57.220884Z',
      properties: {
        address: '10.20.30.20',
        version: 4,
        scope: 'private',
        is_local: true,
        hostnames: [{ name: 'nas-01.local', source: 'mdns' }],
        traffic: {
          packets_sent: 24180,
          packets_received: 9940,
          frame_bytes_sent: 34190220,
          frame_bytes_received: 1092800,
          peer_count: 1,
        },
      },
      inference: {
        is_local_basis: 'rfc1918_and_same_l2_segment',
        machine_bindings: [
          {
            machine_id: 'mac:00:11:32:8a:c4:7d',
            basis: 'arp_reply',
            confidence: 0.97,
            first_seen: '2026-09-04T17:30:03.771204Z',
            last_seen: '2026-09-04T17:37:57.220884Z',
          },
        ],
      },
    },

    {
      id: 'ip:10.20.30.77',
      label: '10.20.30.77',
      node_type: 'host',
      machine_id: 'mac:6a:3f:11:9d:02:c8',
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:12.338001Z',
      last_seen: '2026-09-04T17:37:44.019663Z',
      properties: {
        address: '10.20.30.77',
        version: 4,
        scope: 'private',
        is_local: true,
        hostnames: [],
        traffic: {
          packets_sent: 1138,
          packets_received: 2004,
          frame_bytes_sent: 125400,
          frame_bytes_received: 182960,
          peer_count: 2,
        },
      },
      inference: {
        is_local_basis: 'rfc1918_and_same_l2_segment',
        machine_bindings: [
          {
            machine_id: 'mac:6a:3f:11:9d:02:c8',
            basis: 'dhcp_ack',
            confidence: 0.88,
            first_seen: '2026-09-04T17:31:12.338001Z',
            last_seen: '2026-09-04T17:37:44.019663Z',
          },
        ],
      },
    },

    {
      // The far end of the tunnel. No machine: it is past the gateway, so every
      // frame carrying it had the router MAC and there is nothing to bind to.
      id: 'ip:10.10.0.1',
      label: '10.10.0.1',
      node_type: 'external',
      machine_id: null,
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:40.229118Z',
      last_seen: '2026-09-04T17:37:50.660402Z',
      properties: {
        address: '10.10.0.1',
        version: 4,
        scope: 'private',
        is_local: false,
        hostnames: [{ name: 'vpn.example.net', source: 'dns_ptr' }],
        traffic: {
          packets_sent: 6820,
          packets_received: 3110,
          frame_bytes_sent: 8104200,
          frame_bytes_received: 402300,
          peer_count: 1,
        },
      },
      inference: {
        is_local_basis: 'routed_via_gateway',
        machine_bindings: [],
      },
    },

    {
      id: 'ip:96.7.128.175',
      label: '96.7.128.175',
      node_type: 'external',
      machine_id: null,
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:04.221904Z',
      last_seen: '2026-09-04T17:37:41.339820Z',
      properties: {
        address: '96.7.128.175',
        version: 4,
        scope: 'public',
        is_local: false,
        hostnames: [
          { name: 'example.com', source: 'tls_sni' },
          { name: 'example.com', source: 'dns_ptr' },
        ],
        traffic: {
          packets_sent: 4960,
          packets_received: 2540,
          frame_bytes_sent: 6702860,
          frame_bytes_received: 303120,
          peer_count: 3,
        },
      },
      inference: {
        is_local_basis: 'not_rfc1918_and_routed_via_gateway',
        machine_bindings: [],
      },
    },
  ],

  edges: [
    {
      id: 'edge_ip-10.20.30.1_ip-10.20.30.50',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.1', 'ip:10.20.30.50'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:01.482913Z',
      last_seen: '2026-09-04T17:37:58.104772Z',
      properties: {
        flow_count: 96,
        forward: { packets: 1240, frame_bytes: 168480, payload_bytes: 71320 },
        reverse: { packets: 1190, frame_bytes: 142900, payload_bytes: 58410 },
        services: [
          { port: 53, transport: 'udp', l7_protocols: ['dns'], packets: 2100, frame_bytes: 246300, flow_count: 92 },
          { port: 443, transport: 'tcp', l7_protocols: ['tls', 'http2'], packets: 290, frame_bytes: 58080, flow_count: 3 },
          { port: 67, transport: 'udp', l7_protocols: ['dhcp'], packets: 40, frame_bytes: 7000, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 3,
          syn_ack_count: 3,
          reset_count: 0,
          retransmission_count: 1,
          failed_handshakes: 0,
        },
      },
    },

    {
      id: 'edge_ip-10.20.30.20_ip-10.20.30.50',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.20', 'ip:10.20.30.50'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:03.771204Z',
      last_seen: '2026-09-04T17:37:57.220884Z',
      properties: {
        flow_count: 3,
        forward: { packets: 24180, frame_bytes: 34190220, payload_bytes: 32910640 },
        reverse: { packets: 9940, frame_bytes: 1092800, payload_bytes: 402110 },
        services: [
          { port: 445, transport: 'tcp', l7_protocols: ['smb2'], packets: 34020, frame_bytes: 35241600, flow_count: 2 },
          { port: 139, transport: 'tcp', l7_protocols: ['netbios-ssn'], packets: 100, frame_bytes: 41420, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 3,
          syn_ack_count: 3,
          reset_count: 1,
          retransmission_count: 214,
          failed_handshakes: 0,
        },
      },
    },

    {
      id: 'edge_ip-10.20.30.50_ip-96.7.128.175',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.50', 'ip:96.7.128.175'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:04.221904Z',
      last_seen: '2026-09-04T17:37:41.339820Z',
      properties: {
        flow_count: 14,
        forward: { packets: 1180, frame_bytes: 141600, payload_bytes: 62300 },
        reverse: { packets: 2640, frame_bytes: 3884160, payload_bytes: 3712900 },
        services: [
          { port: 443, transport: 'tcp', l7_protocols: ['tls', 'http2'], packets: 3780, frame_bytes: 4018480, flow_count: 13 },
          { port: 80, transport: 'tcp', l7_protocols: ['http'], packets: 40, frame_bytes: 7280, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 14,
          syn_ack_count: 14,
          reset_count: 2,
          retransmission_count: 9,
          failed_handshakes: 0,
        },
      },
    },

    {
      // The shape the README calls out as worth surfacing: a thousand SYNs,
      // not one SYN/ACK, no payload at all. Tiny on bytes, loud on intent.
      id: 'edge_ip-10.20.30.50_ip-10.20.30.77',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.50', 'ip:10.20.30.77'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:35:02.110577Z',
      last_seen: '2026-09-04T17:35:19.664215Z',
      properties: {
        flow_count: 1024,
        forward: { packets: 1024, frame_bytes: 61440, payload_bytes: 0 },
        reverse: { packets: 118, frame_bytes: 7080, payload_bytes: 0 },
        services: [
          { port: 22, transport: 'tcp', l7_protocols: [], packets: 2, frame_bytes: 120, flow_count: 1 },
          { port: 80, transport: 'tcp', l7_protocols: [], packets: 2, frame_bytes: 120, flow_count: 1 },
          { port: 443, transport: 'tcp', l7_protocols: [], packets: 2, frame_bytes: 120, flow_count: 1 },
          { port: 3389, transport: 'tcp', l7_protocols: [], packets: 2, frame_bytes: 120, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 1024,
          syn_ack_count: 0,
          reset_count: 118,
          retransmission_count: 0,
          failed_handshakes: 1024,
        },
      },
    },

    {
      // Sub-circle two, conversation one: the tunnel itself.
      id: 'edge_ip-10.10.0.1_ip-10.10.0.6',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.10.0.1', 'ip:10.10.0.6'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:40.229118Z',
      last_seen: '2026-09-04T17:37:50.660402Z',
      properties: {
        flow_count: 22,
        forward: { packets: 6820, frame_bytes: 8104200, payload_bytes: 7712400 },
        reverse: { packets: 3110, frame_bytes: 402300, payload_bytes: 188900 },
        services: [
          { port: 1194, transport: 'udp', l7_protocols: ['openvpn'], packets: 9700, frame_bytes: 8464200, flow_count: 20 },
          { port: 443, transport: 'tcp', l7_protocols: ['tls'], packets: 230, frame_bytes: 42300, flow_count: 2 },
        ],
        tcp_health: {
          syn_count: 2,
          syn_ack_count: 2,
          reset_count: 0,
          retransmission_count: 4,
          failed_handshakes: 0,
        },
      },
    },

    {
      // Sub-circle two, conversation two: out to the internet over the tunnel.
      id: 'edge_ip-10.10.0.6_ip-96.7.128.175',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.10.0.6', 'ip:96.7.128.175'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:32:08.771230Z',
      last_seen: '2026-09-04T17:37:20.118844Z',
      properties: {
        flow_count: 9,
        forward: { packets: 940, frame_bytes: 112800, payload_bytes: 48200 },
        reverse: { packets: 1810, frame_bytes: 2416400, payload_bytes: 2298700 },
        services: [
          { port: 443, transport: 'tcp', l7_protocols: ['tls', 'http2'], packets: 2750, frame_bytes: 2529200, flow_count: 9 },
        ],
        tcp_health: {
          syn_count: 9,
          syn_ack_count: 9,
          reset_count: 1,
          retransmission_count: 6,
          failed_handshakes: 0,
        },
      },
    },

    {
      id: 'edge_ip-10.20.30.1_ip-10.20.30.77',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.1', 'ip:10.20.30.77'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:31:12.338001Z',
      last_seen: '2026-09-04T17:37:44.019663Z',
      properties: {
        flow_count: 61,
        forward: { packets: 980, frame_bytes: 121520, payload_bytes: 48900 },
        reverse: { packets: 1020, frame_bytes: 118320, payload_bytes: 44210 },
        services: [
          { port: 53, transport: 'udp', l7_protocols: ['dns'], packets: 1840, frame_bytes: 213440, flow_count: 58 },
          { port: 443, transport: 'tcp', l7_protocols: ['tls'], packets: 100, frame_bytes: 16200, flow_count: 2 },
          { port: 67, transport: 'udp', l7_protocols: ['dhcp'], packets: 60, frame_bytes: 10200, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 2,
          syn_ack_count: 2,
          reset_count: 0,
          retransmission_count: 0,
          failed_handshakes: 0,
        },
      },
    },

    {
      id: 'edge_ip-10.20.30.1_ip-96.7.128.175',
      layer: 'l3',
      directed: false,
      endpoints: ['ip:10.20.30.1', 'ip:96.7.128.175'],
      capture_id: CAPTURE_ID,
      first_seen: '2026-09-04T17:30:11.902441Z',
      last_seen: '2026-09-04T17:36:20.771003Z',
      properties: {
        flow_count: 6,
        forward: { packets: 420, frame_bytes: 48720, payload_bytes: 18900 },
        reverse: { packets: 510, frame_bytes: 402300, payload_bytes: 371200 },
        services: [
          { port: 443, transport: 'tcp', l7_protocols: ['tls'], packets: 880, frame_bytes: 442800, flow_count: 5 },
          { port: 123, transport: 'udp', l7_protocols: ['ntp'], packets: 50, frame_bytes: 8220, flow_count: 1 },
        ],
        tcp_health: {
          syn_count: 5,
          syn_ack_count: 5,
          reset_count: 0,
          retransmission_count: 2,
          failed_handshakes: 0,
        },
      },
    },
  ],
}
