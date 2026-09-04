import { useMemo } from 'react'
import { AddressCircle } from '@/components/AddressCircle'
import { EdgeLine } from '@/components/EdgeLine'
import { MachineGroup } from '@/components/MachineGroup'
import { useForceLayout } from '@/hooks/useForceLayout'
import type { SimBody } from '@/hooks/useForceLayout'
import { buildLayout } from '@/lib/layout'
import { formatBytes } from '@/lib/format'
import { edgeFrameBytes, isScanLike, makeWidthScale } from '@/lib/scales'
import type { CaptureDocument, GraphEdge, Selection } from '@/types/graph'

// Fixed drawing space. The svg scales itself to the pane; getScreenCTM in the
// layout hook keeps pointer coordinates honest when it does.
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

  const selectedId = selection?.id ?? null

  function select(next: NonNullable<Selection>): void {
    // Finishing a drag must not also select what was just moved.
    if (sim.wasDragged()) return
    onSelect(next)
  }

  function sharedBodyProps(simBody: SimBody, x: number, y: number) {
    return {
      x,
      y,
      pinned: simBody.fx != null,
      onPointerDown: (event: React.PointerEvent<SVGGElement>) =>
        sim.handleBodyPointerDown(event, simBody),
      onDoubleClick: () => sim.releaseBody(simBody),
    }
  }

  return (
    <svg
      ref={sim.svgRef}
      className="graph"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      aria-label={`Network graph: ${doc.machines.length} machines, ${doc.nodes.length} addresses, ${doc.edges.length} conversations`}
      onPointerMove={sim.handlePointerMove}
      onPointerUp={sim.handlePointerUp}
      onPointerCancel={sim.handlePointerUp}
    >
      <rect
        className="graph-bg"
        width={WIDTH}
        height={HEIGHT}
        onClick={() => onSelect(null)}
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
  )
}
