import { describe, expect, it } from 'vitest'
import {
  edgeFrameBytes,
  isScanLike,
  makeRadiusScale,
  makeWidthScale,
  nodePackets,
} from '@/lib/scales'
import type { GraphEdge, GraphNode, TcpHealth } from '@/types/graph'

function node(id: string, packets: number): GraphNode {
  return {
    id: `ip:${id}`,
    label: id,
    node_type: 'host',
    machine_id: null,
    capture_id: 'cap_test',
    first_seen: '2026-09-04T17:30:00.000000Z',
    last_seen: '2026-09-04T17:38:00.000000Z',
    properties: {
      address: id,
      version: 4,
      scope: 'private',
      is_local: true,
      hostnames: [],
      traffic: {
        packets_sent: packets,
        packets_received: 0,
        frame_bytes_sent: packets * 100,
        frame_bytes_received: 0,
        peer_count: 1,
      },
    },
  }
}

function edge(bytes: number, health: TcpHealth | null): GraphEdge {
  return {
    id: 'edge_ip-a_ip-b',
    layer: 'l3',
    directed: false,
    endpoints: ['ip:a', 'ip:b'],
    capture_id: 'cap_test',
    first_seen: '2026-09-04T17:30:00.000000Z',
    last_seen: '2026-09-04T17:38:00.000000Z',
    properties: {
      flow_count: 1,
      forward: { packets: 1, frame_bytes: bytes, payload_bytes: 0 },
      reverse: { packets: 1, frame_bytes: 0, payload_bytes: 0 },
      services: [],
      tcp_health: health,
    },
  }
}

const HEALTHY: TcpHealth = {
  syn_count: 4,
  syn_ack_count: 4,
  reset_count: 0,
  retransmission_count: 0,
  failed_handshakes: 0,
}

describe('makeRadiusScale', () => {
  it('encodes volume in area, so radius follows the square root', () => {
    // The smallest node is pinned to the floor of the output range, so the
    // check is on the *shape* of the mapping. sqrt(100)=10, sqrt(400)=20,
    // sqrt(1600)=40, so the middle node lands at (20-10)/(40-10) = 1/3 of the
    // way up. Scaling radius directly would put it at (400-100)/1500 = 0.2.
    const small = node('a', 100)
    const middle = node('b', 400)
    const large = node('c', 1600)
    const radiusFor = makeRadiusScale([small, middle, large])

    const fraction = (radiusFor(middle) - radiusFor(small)) / (radiusFor(large) - radiusFor(small))
    expect(fraction).toBeCloseTo(1 / 3, 5)
    expect(fraction).not.toBeCloseTo(0.2, 2)
  })

  it('does not divide by zero when every node is the same size', () => {
    const a = node('a', 500)
    const b = node('b', 500)
    const radiusFor = makeRadiusScale([a, b])
    expect(radiusFor(a)).toBeGreaterThan(0)
    expect(radiusFor(a)).toBe(radiusFor(b))
  })

  it('does not divide by zero for a single node', () => {
    const only = node('a', 42)
    expect(Number.isFinite(makeRadiusScale([only])(only))).toBe(true)
  })

  it('survives a zero-packet node', () => {
    const quiet = node('a', 0)
    const busy = node('b', 900)
    const radiusFor = makeRadiusScale([quiet, busy])
    expect(Number.isFinite(radiusFor(quiet))).toBe(true)
    expect(radiusFor(quiet)).toBeLessThan(radiusFor(busy))
  })
})

describe('makeWidthScale', () => {
  it('is monotonic in frame bytes', () => {
    const thin = edge(1_000, HEALTHY)
    const fat = edge(1_000_000, HEALTHY)
    const widthFor = makeWidthScale([thin, fat])
    expect(widthFor(thin)).toBeLessThan(widthFor(fat))
  })

  it('sums both directions and nothing else', () => {
    expect(edgeFrameBytes(edge(2_048, HEALTHY))).toBe(2_048)
  })
})

describe('isScanLike', () => {
  it('fires on SYNs with no SYN/ACKs', () => {
    expect(isScanLike(edge(60, { ...HEALTHY, syn_count: 1024, syn_ack_count: 0 }))).toBe(true)
  })

  it('stays quiet on a healthy handshake', () => {
    expect(isScanLike(edge(60, HEALTHY))).toBe(false)
  })

  it('stays quiet when there were no SYNs at all', () => {
    expect(isScanLike(edge(60, { ...HEALTHY, syn_count: 0, syn_ack_count: 0 }))).toBe(false)
  })

  it('stays quiet with no TCP in the conversation', () => {
    expect(isScanLike(edge(60, null))).toBe(false)
  })
})

describe('nodePackets', () => {
  it('counts both directions', () => {
    expect(nodePackets(node('a', 7))).toBe(7)
  })
})
