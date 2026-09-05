import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { sampleCapture } from '@/api/mock'
import { Graph } from '@/components/Graph'
import type { Selection } from '@/types/graph'

function renderGraph(selection: Selection = null) {
  const onSelect = vi.fn<(next: Selection) => void>()
  const view = render(<Graph doc={sampleCapture} selection={selection} onSelect={onSelect} />)
  return { ...view, onSelect }
}

describe('Graph', () => {
  it('draws a body per machine and per unparented address', () => {
    const { container } = renderGraph()
    // 4 machines + 2 addresses past the gateway.
    expect(container.querySelectorAll('.bodies > g')).toHaveLength(6)
  })

  it('draws the two-address machine as a ring with two sub-circles', () => {
    const { container } = renderGraph()
    const rings = container.querySelectorAll('.machine-body')
    expect(rings).toHaveLength(1)
    const group = rings.item(0).parentElement
    expect(group?.querySelectorAll('.address')).toHaveLength(2)
  })

  it('draws every conversation', () => {
    const { container } = renderGraph()
    expect(container.querySelectorAll('.edge')).toHaveLength(sampleCapture.edges.length)
  })

  it('flags the scan-shaped conversation distinctly, regardless of its width', () => {
    const { container } = renderGraph()
    const scans = container.querySelectorAll('.edge-scan')
    expect(scans).toHaveLength(1)
    expect(scans.item(0).getAttribute('aria-label')).toMatch(/scan-shaped/)
  })

  it('puts no undefined or NaN in the DOM', () => {
    const { container } = renderGraph()
    expect(container.innerHTML).not.toMatch(/undefined|NaN/)
  })

  it('leaves nothing on the canvas in the tab order', () => {
    // The graph is pointer-driven by design; only the panel and the upload
    // control are keyboard-operable, and those are real buttons.
    const { container } = renderGraph()
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(0)
  })
})

describe('selecting with a pointer', () => {
  it('reports the machine, not the address, for a click inside the ring', () => {
    const { container, onSelect } = renderGraph()
    const ring = container.querySelector('.machine-body')
    if (ring === null) throw new Error('no expanded machine')
    fireEvent.click(ring)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
  })

  it('makes sub-circles inert, so a press on one reaches the machine', () => {
    const { container } = renderGraph()
    const ring = container.querySelector('.machine-body')
    const children = ring?.parentElement?.querySelectorAll('.address')
    expect(children).toHaveLength(2)
    for (const child of children ?? []) {
      // No handler of its own, and pointer-events: none in the stylesheet, so
      // the click falls through to the ring underneath.
      expect(child.classList.contains('address-inert')).toBe(true)
      expect(child.getAttribute('role')).toBeNull()
    }
  })

  it('still selects a standalone address, which is a body in its own right', () => {
    const { onSelect } = renderGraph()
    const circle = screen.getByLabelText(/^96\.7\.128\.175, external/)
    const group = circle.parentElement
    if (group === null) throw new Error('no standalone address group')
    fireEvent.click(group)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: 'ip:96.7.128.175' })
  })

  it('selects a single-address machine as the machine', () => {
    const { onSelect } = renderGraph()
    const circle = screen.getByLabelText(/^gateway, router/)
    const group = circle.parentElement
    if (group === null) throw new Error('no gateway group')
    fireEvent.click(group)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'machine', id: 'mac:c8:d7:19:04:aa:31' })
  })

  it('selects a conversation from its fat hit line', () => {
    const { container, onSelect } = renderGraph()
    const scan = container.querySelector('.edge-scan .edge-hit')
    if (scan === null) throw new Error('no scan edge')
    fireEvent.click(scan)
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'edge',
      id: 'edge_ip-10.20.30.50_ip-10.20.30.77',
    })
  })

  it('clears the selection on a click in empty space', () => {
    const { container, onSelect } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    const background = container.querySelector('.graph-bg')
    if (background === null) throw new Error('no background')
    fireEvent.click(background)
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('draws a halo on the selected machine', () => {
    const { container } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    expect(container.querySelectorAll('.machine-halo')).toHaveLength(1)
  })

  it('draws a halo on a sub-circle selected from the panel', () => {
    // Not selectable on the canvas, but still highlighted there once the panel
    // picks it -- otherwise the link would point at nothing visible.
    const { container } = renderGraph({ kind: 'node', id: 'ip:10.10.0.6' })
    const ring = container.querySelector('.machine-body')
    expect(ring?.parentElement?.querySelectorAll('.address-halo')).toHaveLength(1)
  })
})
