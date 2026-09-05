import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { sampleCapture } from '@/api/mock'
import { Graph } from '@/components/Graph'
import type { Selection } from '@/types/graph'

/**
 * jsdom has no SVG geometry, so the shared setup stubs getScreenCTM with the
 * identity matrix: a client pixel is a user unit here. The coordinate maths
 * itself is covered in lib/viewport.test.ts; what these assert is the wiring
 * -- which gesture wins the pointer, and what reaches the viewBox attribute.
 */
function renderGraph(selection: Selection = null) {
  const onSelect = vi.fn<(next: Selection) => void>()
  const view = render(<Graph doc={sampleCapture} selection={selection} onSelect={onSelect} />)
  return { ...view, onSelect }
}

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('no svg')
  return svg
}

function viewBox(container: HTMLElement): readonly number[] {
  return (svgOf(container).getAttribute('viewBox') ?? '').split(' ').map(Number)
}

function background(container: HTMLElement): Element {
  const rect = container.querySelector('.graph-bg')
  if (rect === null) throw new Error('no background')
  return rect
}

/** One press-move-release on empty canvas. */
function pan(container: HTMLElement, to: { x: number; y: number }): void {
  const svg = svgOf(container)
  fireEvent.pointerDown(background(container), { pointerId: 7, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(svg, { pointerId: 7, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(svg, { pointerId: 7, clientX: to.x, clientY: to.y })
}

describe('panning the canvas', () => {
  it('starts at the drawing space', () => {
    const { container } = renderGraph()
    expect(viewBox(container)).toEqual([0, 0, 940, 660])
  })

  it('moves the window opposite the drag, so the graph follows the cursor', () => {
    const { container } = renderGraph()
    pan(container, { x: 120, y: 80 })
    const [x, y, width, height] = viewBox(container)
    expect(x).toBeCloseTo(-120, 6)
    expect(y).toBeCloseTo(-80, 6)
    // Panning is not zooming.
    expect(width).toBe(940)
    expect(height).toBe(660)
  })

  it('keeps the background under the pointer however far the view has moved', () => {
    // Otherwise a second pan has nothing to grab: the rect would still be
    // sitting over the original drawing space, now off screen.
    const { container } = renderGraph()
    pan(container, { x: 400, y: 300 })
    const rect = background(container)
    expect(Number(rect.getAttribute('x'))).toBeCloseTo(-400, 6)
    expect(Number(rect.getAttribute('y'))).toBeCloseTo(-300, 6)
  })

  it('does not clear the selection at the end of a pan', () => {
    const { container, onSelect } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    pan(container, { x: 120, y: 80 })
    fireEvent.click(background(container))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still clears it on a plain click on the background', () => {
    const { container, onSelect } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    fireEvent.click(background(container))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('treats a press that barely moves as a click, not a pan', () => {
    const { container, onSelect } = renderGraph({ kind: 'machine', id: 'mac:00:1a:2b:3c:4d:5e' })
    // Under the same 4px slop the body drag uses.
    pan(container, { x: 2, y: 1 })
    fireEvent.click(background(container))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('leaves the view alone while a body is being dragged', () => {
    // The body handler stops propagation, so the pan never starts; both
    // gestures listen at the root and each ignores what is not its own.
    const { container } = renderGraph()
    const ring = container.querySelector('.machine-body')?.parentElement
    if (ring === null || ring === undefined) throw new Error('no machine on the canvas')
    const svg = svgOf(container)
    fireEvent.pointerDown(ring, { pointerId: 3, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(svg, { pointerId: 3, clientX: 250, clientY: 250 })
    fireEvent.pointerUp(svg, { pointerId: 3, clientX: 250, clientY: 250 })
    expect(viewBox(container)).toEqual([0, 0, 940, 660])
  })
})

describe('the view controls', () => {
  it('zooms in on a narrower window and out on a wider one', async () => {
    const { container } = renderGraph()
    const start = viewBox(container)[2] ?? 0

    fireEvent.click(screen.getByLabelText('Zoom in'))
    await waitFor(() => {
      expect(viewBox(container)[2] ?? 0).toBeLessThan(start)
    })

    fireEvent.click(screen.getByLabelText('Zoom out'))
    await waitFor(() => {
      expect(viewBox(container)[2] ?? 0).toBeCloseTo(start, 6)
    })
  })

  it('zooms about the centre, so the middle of the view stays put', () => {
    const { container } = renderGraph()
    fireEvent.click(screen.getByLabelText('Zoom in'))
    const [x, y, width, height] = viewBox(container)
    expect((x ?? 0) + (width ?? 0) / 2).toBeCloseTo(470, 6)
    expect((y ?? 0) + (height ?? 0) / 2).toBeCloseTo(330, 6)
  })

  it('brings every body back into frame with Fit', async () => {
    // The answer to "a circle is off screen and I cannot find it".
    const { container } = renderGraph()
    pan(container, { x: 4000, y: 4000 })

    fireEvent.click(screen.getByText('Fit'))

    await waitFor(() => {
      const [x, y, width, height] = viewBox(container)
      const groups = container.querySelectorAll('.bodies > g')
      expect(groups.length).toBeGreaterThan(0)
      for (const group of groups) {
        const match = group.getAttribute('transform')?.match(/translate\(([-\d.e]+),([-\d.e]+)\)/)
        const cx = Number(match?.[1])
        const cy = Number(match?.[2])
        expect(cx).toBeGreaterThanOrEqual(x ?? 0)
        expect(cx).toBeLessThanOrEqual((x ?? 0) + (width ?? 0))
        expect(cy).toBeGreaterThanOrEqual(y ?? 0)
        expect(cy).toBeLessThanOrEqual((y ?? 0) + (height ?? 0))
      }
    })
  })

  it('goes back to the starting view with Reset', () => {
    const { container } = renderGraph()
    pan(container, { x: 300, y: 200 })
    fireEvent.click(screen.getByLabelText('Zoom in'))
    expect(viewBox(container)).not.toEqual([0, 0, 940, 660])

    fireEvent.click(screen.getByText('Reset'))
    expect(viewBox(container)).toEqual([0, 0, 940, 660])
  })

  it('is reachable as real buttons, since the canvas itself is not', () => {
    renderGraph()
    for (const name of ['Zoom out', 'Zoom in', 'Fit', 'Reset']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })
})
