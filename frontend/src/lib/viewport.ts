import type { UserPoint } from '@/lib/pointer'

/**
 * The window onto the graph's fixed drawing space.
 *
 * Pan and zoom move this rectangle and it is written straight to the svg's
 * viewBox. Nothing about the simulation changes: bodies keep their coordinates
 * in the same drawing space they always had, and `getScreenCTM` -- which
 * includes the viewBox mapping -- keeps dragging accurate at any zoom. A
 * transformed <g> wrapper would look equivalent and would quietly break that,
 * because the matrix on the <svg> element does not see it.
 *
 * This is also not a size encoding. Circle area still means packet volume via
 * @/lib/scales; zooming changes how much of the canvas you can see and nothing
 * about what a circle means.
 */
export interface Viewport {
  x: number
  y: number
  width: number
  height: number
}

/** The drawing space the graph lays itself out in, and the zoom-1 view. */
export interface Extent {
  width: number
  height: number
}

/**
 * A positioned circle. The radius counts: a fit computed from centres alone
 * would clip the largest node exactly when it matters most.
 */
export interface Circle {
  x: number
  y: number
  radius: number
}

// Zoom bounds, as a multiple of the base extent. Far enough out to find a body
// the charge force has thrown well off-canvas, far enough in to read a label.
const MIN_SCALE = 0.15
const MAX_SCALE = 6

const FIT_PADDING = 60

export function initialViewport(base: Extent): Viewport {
  return { x: 0, y: 0, width: base.width, height: base.height }
}

export function viewBoxOf(view: Viewport): string {
  return `${view.x} ${view.y} ${view.width} ${view.height}`
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, x: view.x + dx, y: view.y + dy }
}

export function centreOf(view: Viewport): UserPoint {
  return { x: view.x + view.width / 2, y: view.y + view.height / 2 }
}

/** A wide view means zoomed out, so the bounds invert on the way in. */
function clampWidth(width: number, base: Extent): number {
  return Math.min(Math.max(width, base.width / MAX_SCALE), base.width / MIN_SCALE)
}

/**
 * Zooms by `factor` about `anchor`, a point in user space that stays exactly
 * where it is on screen. Anchoring on the cursor is the whole difference
 * between zooming towards what you are looking at and zooming towards the
 * middle of the canvas and then having to hunt for it again.
 */
export function zoomAt(
  view: Viewport,
  factor: number,
  anchor: UserPoint,
  base: Extent,
): Viewport {
  const width = clampWidth(view.width / factor, base)
  const ratio = width / view.width
  return {
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
    width,
    height: view.height * ratio,
  }
}

/**
 * Where a pinch leaves the view: `grabbed` is the graph point the two fingers
 * came down on, `toward` is where that point has to end up, and `factor` is
 * how much further apart the fingers have moved.
 *
 * Zoom and pan fall out of one calculation rather than being applied in
 * sequence, because a pinch is both at once -- fingers spread and drift, and
 * doing it in two steps makes the graph slide out from under them.
 *
 * Both points are measured against `startView` using the matrix frozen at the
 * start of the gesture, for the reason spelled out in lib/pointer.ts.
 */
export function pinchTo(
  startView: Viewport,
  grabbed: UserPoint,
  toward: UserPoint,
  factor: number,
  base: Extent,
): Viewport {
  const width = clampWidth(startView.width / factor, base)
  const height = width * (startView.height / startView.width)
  // The screen fraction the fingers have moved to, read in the start view.
  const fx = (toward.x - startView.x) / startView.width
  const fy = (toward.y - startView.y) / startView.height
  // Place the view so the grabbed point lands on exactly that fraction.
  return { x: grabbed.x - fx * width, y: grabbed.y - fy * height, width, height }
}

/**
 * The smallest view that holds every circle whole, with room to breathe.
 *
 * This is what answers "where did that node go" -- the force layout has no
 * bound on how far it can push a body, so a busy capture routinely puts
 * circles outside the drawing space entirely.
 */
export function fitTo(
  circles: readonly Circle[],
  base: Extent,
  padding: number = FIT_PADDING,
): Viewport {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const circle of circles) {
    // A body has no coordinates until the simulation has ticked once, and
    // fitting to NaN would blank the canvas.
    if (!Number.isFinite(circle.x) || !Number.isFinite(circle.y)) continue
    minX = Math.min(minX, circle.x - circle.radius)
    minY = Math.min(minY, circle.y - circle.radius)
    maxX = Math.max(maxX, circle.x + circle.radius)
    maxY = Math.max(maxY, circle.y + circle.radius)
  }
  if (!Number.isFinite(minX)) return initialViewport(base)

  // preserveAspectRatio="xMidYMid meet" letterboxes a viewBox whose shape does
  // not match the element, so grow the short side here rather than let the
  // browser silently show more than was asked for and land the content
  // off-centre.
  const aspect = base.width / base.height
  const boxWidth = maxX - minX + padding * 2
  const boxHeight = maxY - minY + padding * 2
  const width = clampWidth(Math.max(boxWidth, boxHeight * aspect), base)
  const height = width / aspect

  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height,
  }
}
