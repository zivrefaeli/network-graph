import { useMemo } from 'react'
import { AddressCircle } from '@/components/AddressCircle'
import { EdgeLine } from '@/components/EdgeLine'
import { MachineGroup } from '@/components/MachineGroup'
import { ViewportControls } from '@/components/ViewportControls'
import { useForceLayout } from '@/hooks/useForceLayout'
import type { SimBody } from '@/hooks/useForceLayout'
import { useViewport } from '@/hooks/useViewport'
import { buildLayout } from '@/lib/layout'
import { formatBytes } from '@/lib/format'
import { edgeFrameBytes, isScanLike, makeWidthScale } from '@/lib/scales'
import type { Circle } from '@/lib/viewport'
import type { CaptureDocument, GraphEdge, Selection } from '@/types/graph'

// Fixed drawing space. The svg scales itself to the pane; getScreenCTM in the
// layout hook keeps pointer coordinates honest when it does.
//
// Bodies are not confined to it. The charge force pushes a busy capture well
// past these bounds, which is why the view pans and zooms over the space
// rather than the space being resized to the window.
const WIDTH = 940
const HEIGHT = 660

interface GraphProps {
  doc: CaptureDocument
  selection: Selection
  onSelect: (selection: Selection) => void
}

function edgeLabel(doc: CaptureDocument, edge: GraphEdge, scanLike: boolean): string {
  const [a, b] = edge.endpoints
  const from = doc.nodes.find((node) => node.id === a)?.label ?? a
  const to = doc.nodes.find((node) => node.id === b)?.label ?? b
  const bytes = formatBytes(edgeFrameBytes(edge))
  const shape = scanLike ? ', scan-shaped' : ''
  return `Conversation between ${from} and ${to}, ${bytes} on the wire${shape}`
}

export function Graph({ doc, selection, onSelect }: GraphProps) {
  const layout = useMemo(() => buildLayout(doc), [doc])
  const widthFor = useMemo(() => makeWidthScale(doc.edges), [doc])
  const sim = useForceLayout(layout, { width: WIDTH, height: HEIGHT })

  // What Fit has to frame: every body where the simulation has actually put
  // it, radius included. Read fresh each render so Fit uses the live layout.
  const circles: Circle[] = sim.simBodies.flatMap((simBody) =>
    Number.isFinite(simBody.x) && Number.isFinite(simBody.y)
      ? [{ x: simBody.x ?? 0, y: simBody.y ?? 0, radius: simBody.body.radius }]
      : [],
  )
  const view = useViewport(sim.svgRef, { width: WIDTH, height: HEIGHT }, circles)

  const selectedId = selection?.id ?? null

  const select = (next: NonNullable<Selection>): void => {
    // Finishing a drag must not also select what was just moved.
    if (sim.wasDragged()) return
    onSelect(next)
  }

  const clearSelection = (): void => {
    // A pan ends with a click on the background, so without this guard moving
    // the canvas would also throw away whatever was selected.
    if (view.wasPanned()) return
    onSelect(null)
  }

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    // Both gestures listen at the root and each ignores events that are not
    // its own, so a body drag and a pan can never both act on one pointer.
    sim.handlePointerMove(event)
    view.handlePointerMove(event)
  }

  const handlePointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    sim.handlePointerUp(event)
    view.handlePointerUp(event)
  }

  const sharedBodyProps = (simBody: SimBody, x: number, y: number) => ({
    x,
    y,
    pinned: simBody.fx != null,
    onPointerDown: (event: React.PointerEvent<SVGGElement>) =>
      sim.handleBodyPointerDown(event, simBody),
    onDoubleClick: () => sim.releaseBody(simBody),
  })

  return (
    <>
      <svg
        ref={sim.svgRef}
        className="graph"
        viewBox={view.viewBox}
        preserveAspectRatio="xMidYMid meet"
        aria-label={`Network graph: ${doc.machines.length} machines, ${doc.nodes.length} addresses, ${doc.edges.length} conversations`}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Covers the view rather than the drawing space, so there is
            somewhere to start a pan however far the view has been moved. */}
        <rect
          className="graph-bg"
          x={view.viewport.x}
          y={view.viewport.y}
          width={view.viewport.width}
          height={view.viewport.height}
          onPointerDown={view.handleBackgroundPointerDown}
          onClick={clearSelection}
        />

        {/* Edges first so lines never draw over the circles they connect. */}
        <g className="edges">
          {doc.edges.map((edge) => {
            const scanLike = isScanLike(edge)
            return (
              <EdgeLine
                key={edge.id}
                from={sim.positionOf(edge.endpoints[0])}
                to={sim.positionOf(edge.endpoints[1])}
                strokeWidth={widthFor(edge)}
                scanLike={scanLike}
                selected={selectedId === edge.id}
                label={edgeLabel(doc, edge, scanLike)}
                onActivate={() => select({ kind: 'edge', id: edge.id })}
              />
            )
          })}
        </g>

        <g className="bodies">
          {sim.simBodies.map((simBody) => {
            const { x, y, body } = simBody
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            const shared = sharedBodyProps(simBody, x ?? 0, y ?? 0)

            if (body.kind === 'machine') {
              return (
                <MachineGroup
                  key={body.id}
                  body={body}
                  selectedId={selectedId}
                  onSelectMachine={(id) => select({ kind: 'machine', id })}
                  {...shared}
                />
              )
            }

            // An address with no machine is the body itself, so it is what a
            // pointer lands on. Only sub-circles inside a machine are inert.
            return (
              <g
                key={body.id}
                className={`machine${shared.pinned ? ' machine-pinned' : ''}`}
                transform={`translate(${shared.x},${shared.y})`}
                onPointerDown={shared.onPointerDown}
                onDoubleClick={shared.onDoubleClick}
                onClick={() => select({ kind: 'node', id: body.node.id })}
              >
                <AddressCircle
                  node={body.node}
                  radius={body.radius}
                  selected={selectedId === body.node.id}
                  labelGap={17}
                />
                {shared.pinned && <circle className="node-pin" r={body.radius + 4} />}
              </g>
            )
          })}
        </g>
      </svg>

      <ViewportControls
        onZoomIn={view.zoomIn}
        onZoomOut={view.zoomOut}
        onFit={view.fit}
        onReset={view.reset}
      />
    </>
  )
}
