import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    const ring = rings.item(0)
    const group = ring.parentElement
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

  it('gives every circle and line a keyboard path and an accessible name', () => {
    const { container } = renderGraph()
    const interactive = container.querySelectorAll('[role="button"]')
    // 4 machines (one ring + three single circles) + 2 sub-circles
    // + 2 standalone addresses + 8 edges.
    expect(interactive).toHaveLength(16)
    for (const element of interactive) {
      expect(element.getAttribute('tabindex')).toBe('0')
      expect(element.getAttribute('aria-label')).toBeTruthy()
    }
  })

  it('selects a machine when Enter is pressed on it', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderGraph()
    const ring = screen.getByLabelText(/workstation-01, machine holding 2 addresses/)
    ring.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
  })

  it('selects a sub-circle without also selecting the machine behind it', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderGraph()
    const child = screen.getByLabelText(/^10\.8\.0\.6, host/)
    child.focus()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: 'ip:10.8.0.6' })
  })

  it('selects a conversation from the keyboard', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderGraph()
    const edge = screen.getByLabelText(/Conversation between 192\.168\.1\.50 and 192\.168\.1\.77/)
    edge.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'edge',
      id: 'edge_ip-192.168.1.50_ip-192.168.1.77',
    })
  })

  it('selects the machine, not the hidden child, for a single-address machine', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderGraph()
    const circle = screen.getByLabelText(/^gateway, router/)
    circle.focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith({ kind: 'machine', id: 'mac:c8:d7:19:04:aa:31' })
  })

  it('marks the selected element as pressed', () => {
    const { container } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
  })
})
