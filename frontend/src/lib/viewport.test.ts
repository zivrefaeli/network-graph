import { describe, expect, it } from 'vitest'
import {
  centreOf,
  fitTo,
  initialViewport,
  panBy,
  pinchTo,
  viewBoxOf,
  zoomAt,
} from '@/lib/viewport'
import type { Circle, Extent, Viewport } from '@/lib/viewport'

const BASE: Extent = { width: 940, height: 660 }

/** Where a user-space point lands within the view, as a 0..1 fraction of it. */
function fractionIn(view: Viewport, point: { x: number; y: number }) {
  return { x: (point.x - view.x) / view.width, y: (point.y - view.y) / view.height }
}

function contains(view: Viewport, circle: Circle): boolean {
  return (
    circle.x - circle.radius >= view.x &&
    circle.y - circle.radius >= view.y &&
    circle.x + circle.radius <= view.x + view.width &&
    circle.y + circle.radius <= view.y + view.height
  )
}

describe('viewBoxOf', () => {
  it('writes the four numbers the svg attribute wants', () => {
    expect(viewBoxOf(initialViewport(BASE))).toBe('0 0 940 660')
  })
})

describe('panBy', () => {
  it('moves the window and leaves its size alone', () => {
    const moved = panBy(initialViewport(BASE), 100, -40)
    expect(moved).toEqual({ x: 100, y: -40, width: 940, height: 660 })
  })
})

describe('zoomAt', () => {
  it('holds the anchor exactly where it was on screen', () => {
    // The whole point of anchoring: zoom towards what you are looking at, not
    // towards the middle of the canvas and then hunt for it again.
    const view = initialViewport(BASE)
    const anchor = { x: 700, y: 120 }
    const before = fractionIn(view, anchor)

    const zoomed = zoomAt(view, 2.5, anchor, BASE)

    const after = fractionIn(zoomed, anchor)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('holds the anchor when zooming out of an already panned view too', () => {
    const view: Viewport = { x: -300, y: 210, width: 470, height: 330 }
    const anchor = { x: 40, y: 400 }
    const before = fractionIn(view, anchor)

    const zoomed = zoomAt(view, 0.4, anchor, BASE)

    const after = fractionIn(zoomed, anchor)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('keeps the aspect ratio, so the browser never letterboxes the view', () => {
    const zoomed = zoomAt(initialViewport(BASE), 3, { x: 100, y: 100 }, BASE)
    expect(zoomed.width / zoomed.height).toBeCloseTo(BASE.width / BASE.height, 10)
  })

  it('stops zooming in, however hard it is asked', () => {
    let view = initialViewport(BASE)
    for (let i = 0; i < 40; i += 1) view = zoomAt(view, 2, centreOf(view), BASE)
    expect(view.width).toBeGreaterThan(0)
    expect(view.width).toBeCloseTo(BASE.width / 6, 6)
  })

  it('stops zooming out, however hard it is asked', () => {
    let view = initialViewport(BASE)
    for (let i = 0; i < 40; i += 1) view = zoomAt(view, 0.5, centreOf(view), BASE)
    expect(view.width).toBeCloseTo(BASE.width / 0.15, 6)
  })
})

describe('pinchTo', () => {
  it('holds the grabbed point under the fingers as they spread', () => {
    const view = initialViewport(BASE)
    const grabbed = { x: 300, y: 500 }
    const pinched = pinchTo(view, grabbed, grabbed, 2, BASE)

    // The fingers did not travel, so the point they came down on has not moved
    // on screen -- it is only that there is now half as much view around it.
    expect(fractionIn(pinched, grabbed)).toEqual(fractionIn(view, grabbed))
    expect(pinched.width).toBeCloseTo(BASE.width / 2, 10)
  })

  it('carries the grabbed point along when the fingers also drift', () => {
    // A real pinch is never pure zoom. Doing the two in sequence instead of at
    // once is what makes the graph slide out from under the fingers.
    const view = initialViewport(BASE)
    const grabbed = { x: 300, y: 500 }
    const toward = { x: 500, y: 200 }

    const pinched = pinchTo(view, grabbed, toward, 1.7, BASE)

    // The grabbed point now sits where the fingers ended up.
    const landed = fractionIn(pinched, grabbed)
    const wanted = fractionIn(view, toward)
    expect(landed.x).toBeCloseTo(wanted.x, 10)
    expect(landed.y).toBeCloseTo(wanted.y, 10)
  })

  it('is a plain pan at a factor of one', () => {
    const view = initialViewport(BASE)
    const pinched = pinchTo(view, { x: 100, y: 100 }, { x: 160, y: 40 }, 1, BASE)
    expect(pinched).toEqual(panBy(view, -60, 60))
  })

  it('keeps the aspect ratio and honours the zoom bounds', () => {
    const view = initialViewport(BASE)
    const squeezed = pinchTo(view, { x: 470, y: 330 }, { x: 470, y: 330 }, 1000, BASE)
    expect(squeezed.width / squeezed.height).toBeCloseTo(BASE.width / BASE.height, 10)
    expect(squeezed.width).toBeCloseTo(BASE.width / 6, 6)
  })
})

describe('fitTo', () => {
  it('frames circles the layout threw well outside the drawing space', () => {
    // This is the case the whole feature exists for: nothing bounds the force
    // layout, so a body can end up thousands of units off-canvas.
    const circles: Circle[] = [
      { x: -1800, y: -900, radius: 30 },
      { x: 2400, y: 1500, radius: 12 },
      { x: 400, y: 300, radius: 20 },
    ]
    const view = fitTo(circles, BASE)
    for (const circle of circles) expect(contains(view, circle)).toBe(true)
  })

  it('frames the whole circle, not just its centre', () => {
    // A fit computed from centres clips the biggest node exactly when it
    // matters, so the radius has to be in the box.
    const circle: Circle = { x: 0, y: 0, radius: 500 }
    const view = fitTo([circle], BASE, 0)
    expect(contains(view, circle)).toBe(true)
  })

  it('keeps the base aspect ratio and centres the content in it', () => {
    // A tall, narrow cluster: the view has to grow sideways rather than let
    // preserveAspectRatio quietly letterbox it off-centre.
    const circles: Circle[] = [
      { x: 100, y: -400, radius: 10 },
      { x: 140, y: 400, radius: 10 },
    ]
    const view = fitTo(circles, BASE)
    expect(view.width / view.height).toBeCloseTo(BASE.width / BASE.height, 10)
    expect(centreOf(view).x).toBeCloseTo(120, 6)
    expect(centreOf(view).y).toBeCloseTo(0, 6)
  })

  it('falls back to the starting view with nothing to frame', () => {
    expect(fitTo([], BASE)).toEqual(initialViewport(BASE))
  })

  it('ignores bodies the simulation has not placed yet', () => {
    // d3 assigns coordinates on the first tick; before that they are NaN, and
    // fitting to one would blank the canvas.
    const placed: Circle = { x: 200, y: 100, radius: 20 }
    const view = fitTo([placed, { x: Number.NaN, y: Number.NaN, radius: 20 }], BASE)
    expect(contains(view, placed)).toBe(true)
    expect(Number.isFinite(view.x)).toBe(true)
    expect(Number.isFinite(view.width)).toBe(true)
  })
})
