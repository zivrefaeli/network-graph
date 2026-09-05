import { describe, expect, it } from 'vitest'
import { sampleCapture } from '@/api/mock'
import { parseCaptureDocument, parseCaptureJson } from '@/api/parse'

/** A deep clone through JSON, which is how a real document arrives anyway. */
function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(sampleCapture)) as Record<string, unknown>
}

function errorsOf(value: unknown): readonly string[] {
  const result = parseCaptureDocument(value)
  if (result.ok) throw new Error('expected the document to be rejected')
  return result.errors
}

function expectRejected(value: unknown, matching: RegExp): void {
  const errors = errorsOf(value)
  expect(errors.some((error) => matching.test(error))).toBe(true)
}

describe('parseCaptureDocument', () => {
  it('accepts the sample document', () => {
    const result = parseCaptureDocument(clone())
    if (!result.ok) throw new Error(`rejected: ${result.errors.join('; ')}`)
    expect(result.document.machines).toHaveLength(4)
    expect(result.document.nodes).toHaveLength(7)
    expect(result.document.edges).toHaveLength(8)
  })

  it('round-trips through JSON text unchanged', () => {
    const result = parseCaptureJson(JSON.stringify(sampleCapture))
    if (!result.ok) throw new Error(`rejected: ${result.errors.join('; ')}`)
    expect(result.document).toEqual(JSON.parse(JSON.stringify(sampleCapture)))
  })

  it('rejects a non-object', () => {
    expectRejected(42, /not a JSON object/)
    expectRejected(null, /not a JSON object/)
    expectRejected([], /not a JSON object/)
  })

  it('rejects a schema version it cannot read', () => {
    const doc = clone()
    doc['schema_version'] = '3.0'
    expectRejected(doc, /schema_version 3\.0 is not supported/)
  })

  it('rejects an l3 edge that terminates on a mac: id', () => {
    // The load-bearing rule: every packet headed off the segment is
    // L2-addressed to the router, so this would collapse the internet onto
    // the gateway.
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    first['endpoints'] = ['ip:10.20.30.50', 'mac:c8:d7:19:04:aa:31']
    expectRejected(doc, /l3 edge must terminate on two "ip:" nodes/)
  })

  it('rejects an l2 edge that terminates on an ip: id', () => {
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    first['layer'] = 'l2'
    expectRejected(doc, /l2 edge must terminate on two "mac:" machines/)
  })

  it('accepts an l2 edge between two machines', () => {
    // ARP has no IP header and so no address to attach to. Machines are the
    // only thing it can connect.
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    first['layer'] = 'l2'
    first['endpoints'] = ['mac:00:1a:2b:3c:4d:5e', 'mac:c8:d7:19:04:aa:31']
    const result = parseCaptureDocument(doc)
    if (!result.ok) throw new Error(`rejected: ${result.errors.join('; ')}`)
  })

  it('rejects unsorted endpoints', () => {
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    first['endpoints'] = ['ip:10.20.30.50', 'ip:10.20.30.1']
    expectRejected(doc, /endpoints must be sorted/)
  })

  it('rejects a missing counter with a message naming the field', () => {
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    const props = first['properties'] as Record<string, unknown>
    const forward = props['forward'] as Record<string, unknown>
    delete forward['payload_bytes']
    expectRejected(doc, /edges\[0\]\.forward: payload_bytes must be a number >= 0/)
  })

  it('rejects a negative counter', () => {
    const doc = clone()
    const nodes = doc['nodes'] as Record<string, unknown>[]
    const first = nodes[0]
    if (first === undefined) throw new Error('expected a node')
    const props = first['properties'] as Record<string, unknown>
    const traffic = props['traffic'] as Record<string, unknown>
    traffic['packets_sent'] = -1
    expectRejected(doc, /traffic\.packets_sent must be a number >= 0/)
  })

  it('rejects an id that is not namespaced', () => {
    const doc = clone()
    const nodes = doc['nodes'] as Record<string, unknown>[]
    const first = nodes[0]
    if (first === undefined) throw new Error('expected a node')
    first['id'] = '10.20.30.50'
    expectRejected(doc, /id must be namespaced as "ip:<address>"/)
  })

  it('rejects a duplicate id', () => {
    const doc = clone()
    const nodes = doc['nodes'] as Record<string, unknown>[]
    const first = nodes[0]
    if (first === undefined) throw new Error('expected a node')
    nodes.push({ ...first })
    expectRejected(doc, /duplicate id ip:10\.20\.30\.50/)
  })

  it('reports a machine naming an address the document does not carry', () => {
    const doc = clone()
    const machines = doc['machines'] as Record<string, unknown>[]
    const first = machines[0]
    if (first === undefined) throw new Error('expected a machine')
    first['node_ids'] = ['ip:10.20.30.50', 'ip:23.215.0.136']
    expectRejected(doc, /node_ids names ip:23\.215\.0\.136, which is not in nodes\[\]/)
  })

  it('reports an edge endpoint the document does not carry', () => {
    const doc = clone()
    const edges = doc['edges'] as Record<string, unknown>[]
    const first = edges[0]
    if (first === undefined) throw new Error('expected an edge')
    first['endpoints'] = ['ip:10.20.30.50', 'ip:23.215.0.136']
    expectRejected(doc, /endpoint ip:23\.215\.0\.136 is not in nodes\[\]/)
  })

  it('allows a machine with no addresses at all', () => {
    // A host that only ever spoke ARP has a MAC and nothing else.
    const doc = clone()
    const machines = doc['machines'] as Record<string, unknown>[]
    machines.push({
      id: 'mac:aa:bb:cc:dd:ee:ff',
      label: 'silent',
      capture_id: 'cap_7f3a9c',
      first_seen: '2026-09-04T17:30:00.000000Z',
      last_seen: '2026-09-04T17:38:00.000000Z',
      node_ids: [],
      properties: {
        mac_address: 'aa:bb:cc:dd:ee:ff',
        mac_is_randomized: false,
        oui: 'aa:bb:cc',
        vendor: null,
        vlan_id: null,
        is_local: true,
        hostnames: [],
        traffic: {
          packets_sent: 0,
          packets_received: 0,
          frame_bytes_sent: 0,
          frame_bytes_received: 0,
          peer_count: 0,
        },
      },
    })
    const result = parseCaptureDocument(doc)
    if (!result.ok) throw new Error(`rejected: ${result.errors.join('; ')}`)
  })
})

describe('parseCaptureJson', () => {
  it('folds a syntax error into the same result shape', () => {
    const result = parseCaptureJson('{ not json')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.at(0)).toMatch(/not valid JSON/)
  })
})
