import { useEffect, useRef, useState } from 'react'
import { slopFor, toUserPoint, userSpaceMapper } from '@/lib/pointer'
import type { UserPoint, UserSpaceMapper } from '@/lib/pointer'
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

// One press of a zoom button. Small enough to stay oriented, big enough that
// it does not take six presses to get anywhere.
const BUTTON_ZOOM_FACTOR = 1.3

// A wheel notch is around 100 deltaY, which this turns into roughly a 16%
// step. Trackpads send many small deltas and get a proportionally small step,
// which is what makes the two feel the same.
const WHEEL_ZOOM_RATE = 0.0015

/** Which gesture a pointerdown started, if it started one. */
export type GestureKind = 'pan' | 'pinch'

export interface ViewportControl {
  viewport: Viewport
  viewBox: string
  handlePointerDown: (event: React.PointerEvent<SVGSVGElement>) => GestureKind | null
  /** Marks a pointer as having landed on empty canvas rather than on a body. */
  markBackgroundPointer: (event: React.PointerEvent<SVGRectElement>) => void
  handlePointerMove: (event: React.PointerEvent<SVGSVGElement>) => void
  handlePointerUp: (event: React.PointerEvent<SVGSVGElement>) => void
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  reset: () => void
  wasPanned: () => boolean
}

/** A pointer currently down on the canvas, updated in place as it moves. */
interface Live {
  clientX: number
  clientY: number
  pointerType: string
}

type Gesture =
  | {
      kind: 'pan'
      pointerId: number
      toUser: UserSpaceMapper
      origin: UserPoint
      startClientX: number
      startClientY: number
      slop: number
      startView: Viewport
    }
  | {
      kind: 'pinch'
      pointerIds: readonly [number, number]
      toUser: UserSpaceMapper
      /** The graph point the two fingers came down on. */
      grabbed: UserPoint
      startGap: number
      startView: Viewport
    }
  | null

function midpointOf(a: Live, b: Live): { clientX: number; clientY: number } {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
}

function gapBetween(a: Live, b: Live): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Owns the svg's viewBox: pan and pinch on the canvas, wheel zoom, and the
 * buttons that go with them.
 *
 * Every pointer over the canvas is tracked, not only the one that started a
 * pan, because two fingers are a pinch and the second can land anywhere --
 * including on a circle, which on a phone is a large and likely target. A
 * second pointer therefore takes the gesture over from whatever was in flight,
 * which is why handlePointerDown reports back what it started.
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

  const livePointers = useRef(new Map<number, Live>())
  const backgroundPointers = useRef(new Set<number>())
  const gestureRef = useRef<Gesture>(null)
  const pannedRef = useRef(false)

  // The committed viewport, for a gesture that begins between renders.
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport

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

  const beginPan = (pointerId: number, live: Live): GestureKind => {
    const toUser = userSpaceMapper(svgRef.current)
    gestureRef.current = {
      kind: 'pan',
      pointerId,
      toUser,
      origin: toUser(live.clientX, live.clientY),
      startClientX: live.clientX,
      startClientY: live.clientY,
      slop: slopFor(live.pointerType),
      startView: viewportRef.current,
    }
    return 'pan'
  }

  /** Begins a pinch on exactly the two pointers currently down. */
  const beginPinch = (): GestureKind | null => {
    const entries = [...livePointers.current.entries()]
    const first = entries.at(0)
    const second = entries.at(1)
    if (first === undefined || second === undefined) return null

    const toUser = userSpaceMapper(svgRef.current)
    const mid = midpointOf(first[1], second[1])
    gestureRef.current = {
      kind: 'pinch',
      pointerIds: [first[0], second[0]],
      toUser,
      grabbed: toUser(mid.clientX, mid.clientY),
      startGap: gapBetween(first[1], second[1]),
      startView: viewportRef.current,
    }
    // Two fingers are never a click on the background, whatever happens next.
    pannedRef.current = true
    return 'pinch'
  }

  const markBackgroundPointer = (event: React.PointerEvent<SVGRectElement>): void => {
    backgroundPointers.current.add(event.pointerId)
    // Captured here, on the background itself, and deliberately not on the svg
    // root where the rest of the gesture is handled. The browser fires click at
    // the nearest common ancestor of the pointerdown and pointerup targets, and
    // capture retargets pointerup to whatever holds it -- so capturing on the
    // root sends the click to the root, past the handler on this rect that
    // clears the selection.
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>): GestureKind | null => {
    const live: Live = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
    }
    livePointers.current.set(event.pointerId, live)

    if (livePointers.current.size === 2) return beginPinch()
    // A third finger is noise on a two-finger gesture, not a new one.
    if (livePointers.current.size > 2) return null

    // A single pointer pans only if it came down on empty canvas. On a body it
    // is a drag, and useForceLayout owns that.
    if (!backgroundPointers.current.has(event.pointerId)) return null
    pannedRef.current = false
    return beginPan(event.pointerId, live)
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const live = livePointers.current.get(event.pointerId)
    if (live !== undefined) {
      live.clientX = event.clientX
      live.clientY = event.clientY
    }

    const gesture = gestureRef.current
    if (gesture === null) return

    if (gesture.kind === 'pan') {
      if (gesture.pointerId !== event.pointerId) return
      // Measured from the start of the gesture against the view it started in,
      // so nothing accumulates: the point grabbed stays under the pointer
      // however many moves it takes to get there.
      const point = gesture.toUser(event.clientX, event.clientY)
      setViewport(panBy(gesture.startView, gesture.origin.x - point.x, gesture.origin.y - point.y))
      const travelled = Math.hypot(
        event.clientX - gesture.startClientX,
        event.clientY - gesture.startClientY,
      )
      if (travelled > gesture.slop) pannedRef.current = true
      return
    }

    const [firstId, secondId] = gesture.pointerIds
    const first = livePointers.current.get(firstId)
    const second = livePointers.current.get(secondId)
    if (first === undefined || second === undefined) return
    const currentGap = gapBetween(first, second)
    // Two fingers landing on the same spot would divide by zero.
    if (gesture.startGap === 0 || currentGap === 0) return

    const mid = midpointOf(first, second)
    setViewport(
      pinchTo(
        gesture.startView,
        gesture.grabbed,
        gesture.toUser(mid.clientX, mid.clientY),
        currentGap / gesture.startGap,
        { width, height },
      ),
    )
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    livePointers.current.delete(event.pointerId)
    backgroundPointers.current.delete(event.pointerId)

    const gesture = gestureRef.current
    if (gesture === null) return
    // pannedRef deliberately survives: the click that follows this pointerup
    // reads it to decide whether the gesture moved the canvas or was a plain
    // click on the background, and only the latter clears the selection.
    gestureRef.current = null

    // Lifting one finger out of a pinch leaves the other still down, and
    // carrying straight on into a pan is what a hand expects. It restarts from
    // the current view rather than resuming, which is what stops the graph
    // jumping at the moment the finger leaves.
    const remaining = [...livePointers.current.entries()].at(0)
    if (gesture.kind === 'pinch' && remaining !== undefined) {
      beginPan(remaining[0], remaining[1])
    }
  }

  const zoomBy = (factor: number): void => {
    setViewport((view) => zoomAt(view, factor, centreOf(view), { width, height }))
  }

  return {
    viewport,
    viewBox: viewBoxOf(viewport),
    handlePointerDown,
    markBackgroundPointer,
    handlePointerMove,
    handlePointerUp,
    zoomIn: () => zoomBy(BUTTON_ZOOM_FACTOR),
    zoomOut: () => zoomBy(1 / BUTTON_ZOOM_FACTOR),
    fit: () => setViewport(fitTo(circlesRef.current, { width, height })),
    reset: () => setViewport(initialViewport({ width, height })),
    wasPanned: () => pannedRef.current,
  }
}
