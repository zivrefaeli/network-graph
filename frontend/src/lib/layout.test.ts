import { describe, expect, it } from 'vitest'
import { sampleCapture } from '@/api/mock'
import { bodyIdOf, buildLayout, edgesForAddress, peerOf, ringRadius } from '@/lib/layout'
import type { Body } from '@/lib/layout'
import type { AddressId, MachineId } from '@/types/graph'

const WORKSTATION: MachineId = 'mac:00:1a:2b:3c:4d:5e'
const LAN: AddressId = 'ip:192.168.1.50'
const VPN: AddressId = 'ip:10.8.0.6'
const GATEWAY: MachineId = 'mac:c8:d7:19:04:aa:31'
const REMOTE: AddressId = 'ip:93.184.216.34'

function machineBody(bodies: readonly Body[], id: MachineId) {
  const body = bodies.find((candidate) => candidate.id === id)
  if (body === undefined || body.kind !== 'machine') {
    throw new Error(`no machine body for ${id}`)
  }
  return body
}

describe('ringRadius', () => {
  it('is zero for fewer than two children -- there is no ring to sit on', () => {
    expect(ringRadius([])).toBe(0)
    expect(ringRadius([20])).toBe(0)
  })

  it('separates two equal children by at least the gap', () => {
    // Two children sit diametrically opposite, so the chord is 2R and the gap
    // between their edges is 2R - 2r.
    const r = 20
    const ring = ringRadius([r, r])
    expect(2 * ring - 2 * r).toBeCloseTo(10, 6)
  })

  it('sizes from the pair that needs the most room, not the average', () => {
    const even = ringRadius([20, 20, 20])
    const lumpy = ringRadius([20, 20, 40])
    expect(lumpy).toBeGreaterThan(even)
  })
})

describe('buildLayout', () => {
  const layout = buildLayout(sampleCapture)

  it('makes a body per machine and per unparented address, and nothing else', () => {
    // 4 machines + the two addresses past the gateway that have no binding.
    expect(layout.bodies).toHaveLength(6)
    const kinds = layout.bodies.map((body) => body.kind)
    expect(kinds.filter((kind) => kind === 'machine')).toHaveLength(4)
    expect(kinds.filter((kind) => kind === 'address')).toHaveLength(2)
  })

  it('expands only the machine with more than one address', () => {
    const expanded = layout.bodies.filter((body) => body.expanded)
    expect(expanded).toHaveLength(1)
    expect(expanded.at(0)?.id).toBe(WORKSTATION)
  })

  it('fits both sub-circles inside the container ring', () => {
    const body = machineBody(layout.bodies, WORKSTATION)
    expect(body.children).toHaveLength(2)
    for (const child of body.children) {
      const reach = Math.hypot(child.dx, child.dy) + child.radius
      expect(reach).toBeLessThanOrEqual(body.radius)
    }
  })

  it('keeps the sub-circles from overlapping', () => {
    const body = machineBody(layout.bodies, WORKSTATION)
    const [first, second] = body.children
    if (first === undefined || second === undefined) throw new Error('expected two children')
    const centres = Math.hypot(first.dx - second.dx, first.dy - second.dy)
    expect(centres).toBeGreaterThanOrEqual(first.radius + second.radius)
  })

  it('draws a single-address machine as one volume-honest circle', () => {
    const body = machineBody(layout.bodies, GATEWAY)
    expect(body.expanded).toBe(false)
    expect(body.children).toHaveLength(1)
    const only = body.children.at(0)
    if (only === undefined) throw new Error('expected one child')
    // No sub-circle: the machine's own radius is the address's radius, so it
    // still reads as a volume encoding rather than a container.
    expect(body.radius).toBe(only.radius)
    expect(only.dx).toBe(0)
    expect(only.dy).toBe(0)
  })

  it('places every address, whether or not it has a machine', () => {
    for (const node of sampleCapture.nodes) {
      expect(layout.placement[node.id]).toBeDefined()
    }
  })

  it('puts an address with a machine inside that machine, not on its own', () => {
    expect(bodyIdOf(layout, LAN)).toBe(WORKSTATION)
    expect(bodyIdOf(layout, VPN)).toBe(WORKSTATION)
  })

  it('leaves an address past the gateway standing alone', () => {
    expect(bodyIdOf(layout, REMOTE)).toBe(REMOTE)
  })

  it('gives sub-circles different offsets so they are separately clickable', () => {
    const lan = layout.placement[LAN]
    const vpn = layout.placement[VPN]
    expect(lan?.dx === vpn?.dx && lan?.dy === vpn?.dy).toBe(false)
  })
})

describe('edgesForAddress', () => {
  it('wires each sub-circle to its own peers', () => {
    // This is the whole point of the example: one machine, two addresses,
    // separate conversations.
    expect(edgesForAddress(sampleCapture, LAN)).toHaveLength(4)
    expect(edgesForAddress(sampleCapture, VPN)).toHaveLength(2)
  })

  it('finds nothing for an address the document does not carry', () => {
    expect(edgesForAddress(sampleCapture, 'ip:203.0.113.9')).toHaveLength(0)
  })
})

describe('peerOf', () => {
  it('reads the other end from either side', () => {
    const edge = edgesForAddress(sampleCapture, VPN).at(0)
    if (edge === undefined) throw new Error('expected an edge')
    const [a, b] = edge.endpoints
    expect(peerOf(edge, a)).toBe(b)
    expect(peerOf(edge, b)).toBe(a)
  })

  it('returns undefined for an address that is not on the edge', () => {
    const edge = edgesForAddress(sampleCapture, VPN).at(0)
    if (edge === undefined) throw new Error('expected an edge')
    expect(peerOf(edge, 'ip:203.0.113.9')).toBeUndefined()
  })
})

describe('a machine whose addresses are all missing', () => {
  it('gets no body rather than an empty ring', () => {
    const layout = buildLayout({
      ...sampleCapture,
      nodes: [],
      edges: [],
    })
    expect(layout.bodies).toHaveLength(0)
  })
})
