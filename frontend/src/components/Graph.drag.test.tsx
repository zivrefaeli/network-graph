import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { sampleCapture } from '@/api/mock'
import { Graph } from '@/components/Graph'

// jsdom implements no SVG geometry at all, so the three APIs the drag path
// depends on are stubbed with the identity transform. That makes the *logic*
// testable -- which body moves, what its children do, whether the pin holds --
// while leaving the coordinate maths itself to a real browser.
beforeAll(() => {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => identity }
  Object.defineProperty(SVGElement.prototype, 'getScreenCTM', {
    configurable: true,
    value: () => identity,
  })
  Object.defineProperty(Element.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => {},
  })
  if (!('DOMPoint' in globalThis)) {
    // Fields declared rather than passed as parameter properties, which
    // erasableSyntaxOnly bans.
    class StubPoint {
      x: number
      y: number
      constructor(x: number, y: number) {
        this.x = x
        this.y = y
      }
      matrixTransform(): StubPoint {
        return this
      }
    }
    Object.defineProperty(globalThis, 'DOMPoint', { configurable: true, value: StubPoint })
  }
})

const WORKSTATION = 'mac:00:1a:2b:3c:4d:5e'

function circleCentre(element: Element): { x: number; y: number } {
  // Walk up to the translated group and read the transform back out. The
  // simulation's numbers are the source of truth; this is what reached the DOM.
  let x = 0
  let y = 0
  let current: Element | null = element
  while (current !== null) {
    const transform = current.getAttribute('transform')
    const match = transform?.match(/translate\(([-\d.e]+),([-\d.e]+)\)/)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      x += Number(match[1])
      y += Number(match[2])
    }
    current = current.parentElement
  }
  return { x, y }
}

function machineGroup(container: HTMLElement): Element {
  const ring = container.querySelector('.machine-body')
  const group = ring?.parentElement
  if (group === null || group === undefined) throw new Error('no expanded machine on screen')
  return group
}

function subCircles(container: HTMLElement): readonly Element[] {
  return Array.from(machineGroup(container).querySelectorAll('.address'))
}

function edgeEnds(container: HTMLElement): readonly { x1: string; y1: string }[] {
  return Array.from(container.querySelectorAll('.edge .edge-line')).map((line) => ({
    x1: line.getAttribute('x1') ?? '',
    y1: line.getAttribute('y1') ?? '',
  }))
}

/**
 * Pointer events set fx/fy on the simulation node; the DOM catches up on the
 * next tick, which is an animation frame away. So the drag is fired and then
 * waited on, exactly as a real one behaves.
 */
async function drag(container: HTMLElement, to: { x: number; y: number }): Promise<void> {
  const group = machineGroup(container)
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('no svg')
  fireEvent.pointerDown(group, { pointerId: 1, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(svg, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(svg, { pointerId: 1, clientX: to.x, clientY: to.y })
  await waitFor(() => {
    expect(circleCentre(machineGroup(container))).toEqual(to)
  })
}

function renderGraph() {
  const onSelect = vi.fn()
  const view = render(
    <Graph doc={sampleCapture} selection={null} onSelect={onSelect} />,
  )
  return { ...view, onSelect }
}

describe('dragging a machine', () => {
  it('moves it to where it was dropped', async () => {
    const { container } = renderGraph()
    await drag(container, { x: 200, y: 240 })
    expect(circleCentre(machineGroup(container))).toEqual({ x: 200, y: 240 })
  })

  it('carries both sub-circles with it, keeping their offsets', async () => {
    const { container } = renderGraph()
    const before = subCircles(container).map(circleCentre)
    const origin = circleCentre(machineGroup(container))

    await drag(container, { x: 200, y: 240 })

    const after = subCircles(container).map(circleCentre)
    expect(after).toHaveLength(2)
    for (const [i, position] of after.entries()) {
      const start = before[i]
      if (start === undefined) throw new Error('lost a sub-circle')
      // Children are offsets from the parent centre, so each one moves by
      // exactly the distance the parent moved. Nothing has to stay in sync.
      expect(position.x - start.x).toBeCloseTo(200 - origin.x, 6)
      expect(position.y - start.y).toBeCloseTo(240 - origin.y, 6)
    }
    // And they are still two distinct circles, not one on top of the other.
    expect(after.at(0)).not.toEqual(after.at(1))
  })

  it('drags the lines that terminate on those sub-circles along too', async () => {
    const { container } = renderGraph()
    const before = edgeEnds(container)
    await drag(container, { x: 200, y: 240 })
    const after = edgeEnds(container)
    expect(after).toHaveLength(sampleCapture.edges.length)
    // The workstation's six conversations all moved an endpoint.
    const moved = after.filter((end, i) => {
      const start = before[i]
      return start !== undefined && (start.x1 !== end.x1 || start.y1 !== end.y1)
    })
    expect(moved.length).toBeGreaterThan(0)
  })

  it('holds its dropped position, and shows a pin to say so', async () => {
    const { container } = renderGraph()
    await drag(container, { x: 200, y: 240 })
    expect(machineGroup(container).querySelector('.node-pin')).not.toBeNull()

    // Let the simulation run: a pinned body must not drift.
    act(() => {
      fireEvent.pointerMove(container.querySelector('svg') ?? container, {
        pointerId: 2,
        clientX: 900,
        clientY: 900,
      })
    })
    expect(circleCentre(machineGroup(container))).toEqual({ x: 200, y: 240 })
  })

  it('does not also select the machine it just moved', async () => {
    const { container, onSelect } = renderGraph()
    await drag(container, { x: 200, y: 240 })
    fireEvent.click(machineGroup(container).querySelector('.machine-body') ?? container)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('treats a press that barely moves as a click, not a drag', async () => {
    const { container, onSelect } = renderGraph()
    // Under the 4px slop threshold. Without it, finishing any drag would also
    // select whatever was moved.
    await drag(container, { x: 2, y: 1 })
    fireEvent.click(machineGroup(container).querySelector('.machine-body') ?? container)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'machine', id: WORKSTATION })
  })

  it('hands the machine back to the layout on double-click', async () => {
    const { container } = renderGraph()
    await drag(container, { x: 200, y: 240 })
    expect(machineGroup(container).querySelector('.node-pin')).not.toBeNull()

    fireEvent.doubleClick(machineGroup(container))
    await waitFor(() => {
      expect(machineGroup(container).querySelector('.node-pin')).toBeNull()
    })
  })
})
