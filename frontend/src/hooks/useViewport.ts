import { useEffect, useRef, useState } from 'react'
import { DRAG_SLOP_PX, toUserPoint, userSpaceMapper } from '@/lib/pointer'
import { centreOf, fitTo, initialViewport, panBy, viewBoxOf, zoomAt } from '@/lib/viewport'
import type { Circle, Extent, Viewport } from '@/lib/viewport'
import type { UserSpaceMapper } from '@/lib/pointer'

// One press of a zoom button. Small enough to stay oriented, big enough that
// it does not take six presses to get anywhere.
const BUTTON_ZOOM_FACTOR = 1.3

// A wheel notch is around 100 deltaY, which this turns into roughly a 16%
// step. Trackpads send many small deltas and get a proportionally small step,
// which is what makes the two feel the same.
const WHEEL_ZOOM_RATE = 0.0015

export interface ViewportControl {
  viewport: Viewport
  viewBox: string
  handleBackgroundPointerDown: (event: React.PointerEvent<SVGRectElement>) => void
  handlePointerMove: (event: React.PointerEvent<SVGSVGElement>) => void
  handlePointerUp: (event: React.PointerEvent<SVGSVGElement>) => void
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  reset: () => void
  wasPanned: () => boolean
}

interface Pan {
  pointerId: number
  /** Frozen at pointerdown -- see userSpaceMapper for why it must not be re-read. */
  toUser: UserSpaceMapper
  origin: { x: number; y: number }
  clientX: number
  clientY: number
  startView: Viewport
}

/**
 * Owns the svg's viewBox: the pan gesture on the background, wheel zoom, and
 * the buttons that go with them.
 *
 * `circles` is whatever the view should be able to frame, in the same user
 * space the bodies live in. It is read through a ref rather than captured,
 * because the simulation moves under it on every tick and Fit must use where
 * things are now, not where they were when the handler was created.
 */
export function useViewport(
  svgRef: React.RefObject<SVGSVGElement | null>,
  base: Extent,
  circles: readonly Circle[],
): ViewportControl {
  const { width, height } = base
  const [viewport, setViewport] = useState<Viewport>(() => initialViewport(base))
  const panRef = useRef<Pan | null>(null)
  const pannedRef = useRef(false)

  const circlesRef = useRef(circles)
  circlesRef.current = circles

  // React registers onWheel passively at the root, so preventDefault there is
  // a no-op and the page scrolls out from under the zoom. The listener has to
  // be attached by hand to opt out of that.
  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const anchor = toUserPoint(svg, event.clientX, event.clientY)
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE)
      setViewport((view) => zoomAt(view, factor, anchor, { width, height }))
    }

    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef, width, height])

  const handleBackgroundPointerDown = (event: React.PointerEvent<SVGRectElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    pannedRef.current = false
    const toUser = userSpaceMapper(svgRef.current)
    panRef.current = {
      pointerId: event.pointerId,
      toUser,
      origin: toUser(event.clientX, event.clientY),
      clientX: event.clientX,
      clientY: event.clientY,
      startView: viewport,
    }
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    // Measured from the start of the gesture against the view it started in,
    // so nothing accumulates: the point grabbed stays under the cursor however
    // many moves it takes to get there.
    const point = pan.toUser(event.clientX, event.clientY)
    setViewport(panBy(pan.startView, pan.origin.x - point.x, pan.origin.y - point.y))
    const travelled = Math.hypot(event.clientX - pan.clientX, event.clientY - pan.clientY)
    if (travelled > DRAG_SLOP_PX) pannedRef.current = true
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    // pannedRef deliberately survives: the click that follows this pointerup
    // reads it to decide whether the gesture was a pan or a plain click on the
    // background, and only the latter clears the selection.
    panRef.current = null
  }

  const zoomBy = (factor: number): void => {
    setViewport((view) => zoomAt(view, factor, centreOf(view), { width, height }))
  }

  return {
    viewport,
    viewBox: viewBoxOf(viewport),
    handleBackgroundPointerDown,
    handlePointerMove,
    handlePointerUp,
    zoomIn: () => zoomBy(BUTTON_ZOOM_FACTOR),
    zoomOut: () => zoomBy(1 / BUTTON_ZOOM_FACTOR),
    fit: () => setViewport(fitTo(circlesRef.current, { width, height })),
    reset: () => setViewport(initialViewport({ width, height })),
    wasPanned: () => pannedRef.current,
  }
}
