import { describe, expect, it } from 'vitest'
import { sampleCapture as doc } from '@/api/mock'
import type { AddressId, Counters, GraphEdge, Traffic } from '@/types/graph'

// The mock is the contract check. If a circle's size and the number the panel
// prints beside it can disagree, everything downstream is decoration -- so the
// same invariants README.md asks the backend to hold are asserted here.

function counters(edge: GraphEdge, from: AddressId): { sent: Counters; received: Counters } {
  const outbound = edge.endpoints[0] === from
  return outbound
    ? { sent: edge.properties.forward, received: edge.properties.reverse }
    : { sent: edge.properties.reverse, received: edge.properties.forward }
}

function trafficFromEdges(id: AddressId): Traffic {
  const peers = new Set<AddressId>()
  const total: Traffic = {
    packets_sent: 0,
    packets_received: 0,
    frame_bytes_sent: 0,
    frame_bytes_received: 0,
    peer_count: 0,
  }
  for (const edge of doc.edges) {
    const [a, b] = edge.endpoints
    if (a !== id && b !== id) continue
    const { sent, received } = counters(edge, id)
    total.packets_sent += sent.packets
    total.frame_bytes_sent += sent.frame_bytes
    total.packets_received += received.packets
    total.frame_bytes_received += received.frame_bytes
    peers.add(a === id ? b : a)
  }
  total.peer_count = peers.size
  return total
}

describe('the sample capture', () => {
  it("makes every address's traffic the sum of its edges", () => {
    // The level that catches double-counting.
    for (const node of doc.nodes) {
      expect(node.properties.traffic, node.id).toEqual(trafficFromEdges(node.id))
    }
  })

  it("makes every machine's traffic the sum of its addresses", () => {
    for (const machine of doc.machines) {
      const children = machine.node_ids.map((id) =>
        doc.nodes.find((node) => node.id === id),
      )
      const peers = new Set<AddressId>()
      const total: Traffic = {
        packets_sent: 0,
        packets_received: 0,
        frame_bytes_sent: 0,
        frame_bytes_received: 0,
        peer_count: 0,
      }
      for (const child of children) {
        expect(child, `${machine.id} names an address the document lacks`).toBeDefined()
        if (child === undefined) continue
        const t = child.properties.traffic
        total.packets_sent += t.packets_sent
        total.packets_received += t.packets_received
        total.frame_bytes_sent += t.frame_bytes_sent
        total.frame_bytes_received += t.frame_bytes_received
        for (const edge of doc.edges) {
          const [a, b] = edge.endpoints
          if (a === child.id) peers.add(b)
          else if (b === child.id) peers.add(a)
        }
      }
      // peer_count counts distinct peer addresses across every node, deduped.
      total.peer_count = peers.size
      expect(machine.properties.traffic, machine.id).toEqual(total)
    }
  })

  it('sorts every endpoint pair and derives the id from it', () => {
    for (const edge of doc.edges) {
      const [a, b] = edge.endpoints
      expect(a < b, `${edge.id} endpoints are not sorted`).toBe(true)
      const derived = `edge_${a.replace(':', '-')}_${b.replace(':', '-')}`
      expect(edge.id).toBe(derived)
    }
  })

  it('never terminates an l3 edge on a mac: id', () => {
    for (const edge of doc.edges) {
      if (edge.layer !== 'l3') continue
      for (const endpoint of edge.endpoints) {
        expect(endpoint.startsWith('ip:'), `${edge.id} terminates on ${endpoint}`).toBe(true)
      }
    }
  })

  it('keeps machine and address back-references in step', () => {
    for (const machine of doc.machines) {
      for (const id of machine.node_ids) {
        const node = doc.nodes.find((entry) => entry.id === id)
        expect(node?.machine_id, id).toBe(machine.id)
      }
    }
    for (const node of doc.nodes) {
      if (node.machine_id === null) continue
      const machine = doc.machines.find((entry) => entry.id === node.machine_id)
      expect(machine?.node_ids).toContain(node.id)
    }
  })

  it('leaves no vendor on a randomized MAC', () => {
    for (const machine of doc.machines) {
      if (!machine.properties.mac_is_randomized) continue
      expect(machine.properties.vendor).toBeNull()
      expect(machine.properties.oui).toBeNull()
    }
  })

  it('gives every address past the gateway no machine and no binding', () => {
    for (const node of doc.nodes) {
      if (node.machine_id !== null) continue
      expect(node.inference?.machine_bindings ?? []).toHaveLength(0)
      // Never invent a parent -- but always say why there is none.
      expect(node.inference?.is_local_basis).toBeTruthy()
    }
  })

  it('carries exactly one machine with more than one address', () => {
    const multi = doc.machines.filter((machine) => machine.node_ids.length > 1)
    expect(multi).toHaveLength(1)
    expect(multi.at(0)?.label).toBe('workstation-01')
  })
})
