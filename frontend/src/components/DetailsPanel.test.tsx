import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { sampleCapture } from '@/api/mock'
import { DetailsPanel } from '@/components/DetailsPanel'
import type { Selection } from '@/types/graph'

/**
 * The schema guarantees these fields exist, so every element in the document
 * must render without a hole in it. "undefined" or "NaN" reaching the DOM is
 * the failure this catches -- a panel that silently prints NaN for a byte
 * count is worse than one that throws.
 */
function renderSelection(selection: Selection): string {
  const { container } = render(
    <DetailsPanel doc={sampleCapture} selection={selection} onSelect={() => {}} />,
  )
  const text = container.textContent ?? ''
  expect(text).not.toMatch(/undefined|NaN|\[object Object\]/)
  return text
}

describe('DetailsPanel', () => {
  it('renders the empty state with no selection', () => {
    expect(renderSelection(null)).toMatch(/Click a machine/)
  })

  it('renders every machine in the document', () => {
    for (const machine of sampleCapture.machines) {
      const text = renderSelection({ kind: 'machine', id: machine.id })
      expect(text).toContain(machine.label)
      expect(text).toContain(machine.properties.mac_address)
    }
  })

  it('renders every address in the document', () => {
    for (const node of sampleCapture.nodes) {
      const text = renderSelection({ kind: 'node', id: node.id })
      expect(text).toContain(node.properties.address)
      expect(text).toContain(node.node_type)
    }
  })

  it('renders every conversation in the document', () => {
    for (const edge of sampleCapture.edges) {
      const text = renderSelection({ kind: 'edge', id: edge.id })
      expect(text).toContain(edge.id)
    }
  })

  it('says the container ring is not a volume encoding', () => {
    const text = renderSelection({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    expect(text).toMatch(/container sized to hold them, not to encode volume/)
  })

  it('does not claim a single-address machine is a container', () => {
    const text = renderSelection({ kind: 'machine', id: 'mac:c8:d7:19:04:aa:31' })
    expect(text).toMatch(/The circle is sized from/)
    expect(text).not.toMatch(/not to encode volume/)
  })

  it('explains a randomized MAC instead of showing an empty vendor', () => {
    const text = renderSelection({ kind: 'machine', id: 'mac:6a:3f:11:9d:02:c8' })
    expect(text).toMatch(/Randomized MAC/)
  })

  it('explains why an address past the gateway has no machine', () => {
    const text = renderSelection({ kind: 'node', id: 'ip:93.184.216.34' })
    expect(text).toMatch(/every frame for this address carried the router MAC/)
  })

  it('shows the binding basis beside an inferred machine membership', () => {
    const text = renderSelection({ kind: 'node', id: 'ip:192.168.1.50' })
    expect(text).toContain('arp_reply')
    expect(text).toContain('98%')
  })

  it('calls the scan a scan', () => {
    const text = renderSelection({ kind: 'edge', id: 'edge_ip-192.168.1.50_ip-192.168.1.77' })
    expect(text).toMatch(/That is a scan, not a conversation/)
    expect(text).toContain('1,024')
  })

  it('shows both directions rather than one merged total', () => {
    const text = renderSelection({ kind: 'edge', id: 'edge_ip-192.168.1.20_ip-192.168.1.50' })
    // 24,180 forward and 9,940 reverse: the asymmetry is the point.
    expect(text).toContain('24,180')
    expect(text).toContain('9,940')
  })

  it('reports a dangling reference instead of crashing on it', () => {
    const text = renderSelection({ kind: 'node', id: 'ip:203.0.113.9' })
    expect(text).toMatch(/referenced but is not in this document/)
  })
})
