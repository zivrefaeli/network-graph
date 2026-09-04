import { useEffect, useMemo, useRef, useState } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from 'd3-force'
import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { bodyIdOf } from '@/lib/layout'
import type { Body, Layout } from '@/lib/layout'
import type { AddressId, EdgeId, NodeId } from '@/types/graph'

// A press that moves less than this counts as a click, not a drag. Without it,
// finishing a drag would also select whatever you just finished moving.
const DRAG_SLOP_PX = 4

const LINK_BASE_DISTANCE = 150
const CHARGE_STRENGTH = -2200
const COLLIDE_PAD = 14

export interface SimBody extends SimulationNodeDatum {
  id: NodeId
  body: Body
}

interface SimLink extends SimulationLinkDatum<SimBody> {
  id: EdgeId
}

export interface Point {
  x: number
  y: number
  radius: number
}

export interface ForceLayout {
  svgRef: React.RefObject<SVGSVGElement | null>
  simBodies: readonly SimBody[]
  positionOf: (addressId: AddressId) => Point | null
  handleBodyPointerDown: (event: React.PointerEvent<SVGGElement>, simBody: SimBody) => void
  handlePointerMove: (event: React.PointerEvent<SVGSVGElement>) => void
  handlePointerUp: (event: React.PointerEvent<SVGSVGElement>) => void
  releaseBody: (simBody: SimBody) => void
  wasDragged: () => boolean
}

/**
 * Runs a d3 force simulation over the layout's bodies and hands back live
 * positions plus the pointer handlers that make them draggable.
 *
 * The simulation only ever sees bodies -- machines and unparented addresses.
 * Addresses inside a machine are placed relative to their parent, so
 * `positionOf` is what edges read, and a dragged machine carries its
 * sub-circles and their lines without the simulation knowing they exist.
 *
 * Dragging uses native pointer events rather than d3-drag: React owns this DOM
 * and the two would fight over it.
 */
export function useForceLayout(layout: Layout, size: { width: number; height: number }): ForceLayout {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const simRef = useRef<ReturnType<typeof forceSimulation<SimBody>> | null>(null)
  const dragRef = useRef<{
    simBody: SimBody
    pointerId: number
    originX: number
    originY: number
  } | null>(null)
  const draggedRef = useRef(false)

  // d3-force mutates whatever it is handed, so it gets these wrappers and the
  // layout -- and the document behind it -- stays clean.
  const simBodies = useMemo<SimBody[]>(
    () => layout.bodies.map((body) => ({ id: body.id, body })),
    [layout],
  )
  const simBodyById = useMemo(() => {
    const map = new Map<NodeId, SimBody>()
    for (const simBody of simBodies) map.set(simBody.id, simBody)
    return map
  }, [simBodies])

  const simLinks = useMemo<SimLink[]>(() => {
    const links: SimLink[] = []
    for (const edge of Object.values(layout.edgeById)) {
      if (edge === undefined || edge.layer !== 'l3') continue
      const source = bodyIdOf(layout, edge.endpoints[0])
      const target = bodyIdOf(layout, edge.endpoints[1])
      // Both endpoints inside the same machine: the line is still drawn, but
      // there is nothing for a spring between a body and itself to pull on.
      if (source === undefined || target === undefined || source === target) continue
      links.push({ id: edge.id, source, target })
    }
    return links
  }, [layout])

  // Bumped once per tick purely to re-render. A handful of bodies makes that
  // free. Past roughly 150 bodies, stop re-rendering and write `transform`
  // straight onto element refs; past a few thousand, SVG is the wrong renderer
  // and this moves to canvas. Real captures reach both.
  const [, setFrame] = useState(0)

  const { width, height } = size

  useEffect(() => {
    const sim = forceSimulation<SimBody>(simBodies)
      .force(
        'link',
        forceLink<SimBody, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((link) => {
            const source = link.source
            const target = link.target
            const sourceRadius = typeof source === 'object' ? source.body.radius : 0
            const targetRadius = typeof target === 'object' ? target.body.radius : 0
            return LINK_BASE_DISTANCE + sourceRadius + targetRadius
          })
          .strength(0.35),
      )
      .force('charge', forceManyBody<SimBody>().strength(CHARGE_STRENGTH))
      .force('center', forceCenter(width / 2, height / 2))
      // The same radius the renderer uses, or circles overlap.
      .force('collide', forceCollide<SimBody>((d) => d.body.radius + COLLIDE_PAD))
      .on('tick', () => setFrame((frame) => frame + 1))

    simRef.current = sim
    // d3 assigns starting coordinates synchronously when it is handed the
    // nodes, but the first `tick` is an animation frame away. Paint once now
    // so nothing renders a frame of empty canvas.
    setFrame((frame) => frame + 1)

    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [simBodies, simLinks, width, height])

  /** Absolute canvas position of an address, parent offset included. */
  const positionOf = (addressId: AddressId): Point | null => {
    const place = layout.placement[addressId]
    if (place === undefined) return null
    const simBody = simBodyById.get(place.bodyId)
    if (simBody === undefined) return null
    const { x, y } = simBody
    // A body has no coordinates until the simulation has ticked once.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x: (x ?? 0) + place.dx, y: (y ?? 0) + place.dy, radius: place.radius }
  }

  // Client coordinates go through the SVG matrix rather than being used raw,
  // so dragging stays accurate however the viewBox is scaled to the window.
  const toSvgPoint = (event: React.PointerEvent<SVGElement>): { x: number; y: number } => {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (svg === null || ctm === null || ctm === undefined) {
      return { x: event.clientX, y: event.clientY }
    }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return { x: point.x, y: point.y }
  }

  const handleBodyPointerDown = (
    event: React.PointerEvent<SVGGElement>,
    simBody: SimBody,
  ): void => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    draggedRef.current = false
    dragRef.current = {
      simBody,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
    }
    simBody.fx = simBody.x
    simBody.fy = simBody.y
    simRef.current?.alphaTarget(0.3).restart()
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const point = toSvgPoint(event)
    drag.simBody.fx = point.x
    drag.simBody.fy = point.y
    const travelled = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY)
    if (travelled > DRAG_SLOP_PX) draggedRef.current = true
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    // fx and fy deliberately stay set. The body keeps the spot it was dropped
    // on while everything else settles around it; double-click lets it go.
    simRef.current?.alphaTarget(0)
  }

  const releaseBody = (simBody: SimBody): void => {
    simBody.fx = null
    simBody.fy = null
    simRef.current?.alpha(0.6).restart()
  }

  return {
    svgRef,
    simBodies,
    positionOf,
    handleBodyPointerDown,
    handlePointerMove,
    handlePointerUp,
    releaseBody,
    wasDragged: () => draggedRef.current,
  }
}
