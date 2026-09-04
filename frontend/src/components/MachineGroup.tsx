import { AddressCircle } from '@/components/AddressCircle'
import { formatCount } from '@/lib/format'
import { machinePackets } from '@/lib/scales'
import type { Body } from '@/lib/layout'
import type { MachineId } from '@/types/graph'

interface MachineGroupProps {
  body: Extract<Body, { kind: 'machine' }>
  x: number
  y: number
  pinned: boolean
  selectedId: string | null
  onSelectMachine: (id: MachineId) => void
  onPointerDown: (event: React.PointerEvent<SVGGElement>) => void
  onDoubleClick: () => void
}

/**
 * One machine.
 *
 * With a single address it is just that address's circle wearing the machine
 * name -- one child inside one parent is noise -- and it stays volume-honest.
 * With more than one it becomes a container ring holding a sub-circle per
 * address, and edges attach to those rather than to the ring. The ring is
 * sized to fit its children, so it does *not* encode volume, which is why it
 * is drawn hollow and said out loud in the legend and the panel.
 *
 * The machine is the only thing on the canvas a pointer can hit here: the
 * sub-circles are inert, so a press anywhere inside the ring selects or drags
 * the machine. Individual addresses are reached from the panel.
 */
export function MachineGroup({
  body,
  x,
  y,
  pinned,
  selectedId,
  onSelectMachine,
  onPointerDown,
  onDoubleClick,
}: MachineGroupProps) {
  const { machine, radius, expanded, children } = body
  const selected = selectedId === machine.id

  const groupProps = {
    className: `machine${pinned ? ' machine-pinned' : ''}`,
    transform: `translate(${x},${y})`,
    'aria-label': `${machine.label}, machine, ${formatCount(machinePackets(machine))} packets`,
    onPointerDown,
    onDoubleClick,
    onClick: () => onSelectMachine(machine.id),
  }

  if (!expanded) {
    const only = children[0]
    if (only === undefined) return null
    return (
      <g {...groupProps}>
        {selected && <circle className="address-halo" r={radius + 7} />}
        <AddressCircle
          node={only.node}
          radius={radius}
          selected={selected}
          labelGap={17}
          label={machine.label}
        />
        {pinned && <circle className="node-pin" r={radius + 4} />}
      </g>
    )
  }

  return (
    <g {...groupProps}>
      {selected && <circle className="machine-halo" r={radius + 7} />}
      {/* The ring spans the whole body, so it is what a pointer lands on --
          including through the inert sub-circles drawn over it. */}
      <circle className="machine-body" r={radius} />
      <text className="machine-label" y={-radius - 9}>
        {machine.label}
      </text>

      {children.map((child) => (
        <g key={child.node.id} transform={`translate(${child.dx},${child.dy})`}>
          <AddressCircle
            node={child.node}
            radius={child.radius}
            selected={selectedId === child.node.id}
            inert
          />
        </g>
      ))}

      {/* Dashed ring means the machine was dropped here and is holding position. */}
      {pinned && <circle className="node-pin" r={radius + 4} />}
    </g>
  )
}
