import { AddressCircle } from '@/components/AddressCircle'
import { formatCount } from '@/lib/format'
import { machinePackets } from '@/lib/scales'
import type { Body } from '@/lib/layout'
import type { AddressId, Machine, MachineId } from '@/types/graph'

interface MachineGroupProps {
  body: Extract<Body, { kind: 'machine' }>
  x: number
  y: number
  pinned: boolean
  selectedId: string | null
  onSelectMachine: (id: MachineId) => void
  onSelectNode: (id: AddressId) => void
  onPointerDown: (event: React.PointerEvent<SVGGElement>) => void
  onDoubleClick: () => void
}

function machineLabel(machine: Machine, expanded: boolean): string {
  const packets = formatCount(machinePackets(machine))
  return expanded
    ? `${machine.label}, machine holding ${machine.node_ids.length} addresses, ${packets} packets`
    : `${machine.label}, machine, ${packets} packets`
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
 */
export function MachineGroup({
  body,
  x,
  y,
  pinned,
  selectedId,
  onSelectMachine,
  onSelectNode,
  onPointerDown,
  onDoubleClick,
}: MachineGroupProps) {
  const { machine, radius, expanded, children } = body
  const selected = selectedId === machine.id

  const groupProps = {
    className: `machine${pinned ? ' machine-pinned' : ''}`,
    transform: `translate(${x},${y})`,
    onPointerDown,
    onDoubleClick,
  }

  function handleKeyDown(event: React.KeyboardEvent<SVGGElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelectMachine(machine.id)
  }

  if (!expanded) {
    const only = children[0]
    if (only === undefined) return null
    // Selecting the invisible child would be surprising when no sub-circle is
    // drawn, so the click lands on the machine and the panel links inward.
    return (
      <g {...groupProps}>
        {selected && <circle className="address-halo" r={radius + 7} />}
        <AddressCircle
          node={only.node}
          radius={radius}
          selected={selected}
          labelGap={17}
          label={machine.label}
          onActivate={() => onSelectMachine(machine.id)}
        />
        {pinned && <circle className="node-pin" r={radius + 4} />}
      </g>
    )
  }

  return (
    <g {...groupProps}>
      {selected && <circle className="machine-halo" r={radius + 7} />}
      <circle
        className="machine-body"
        r={radius}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={machineLabel(machine, true)}
        onClick={() => onSelectMachine(machine.id)}
        onKeyDown={handleKeyDown}
      />
      <text className="machine-label" y={-radius - 9}>
        {machine.label}
      </text>

      {children.map((child) => (
        <g key={child.node.id} transform={`translate(${child.dx},${child.dy})`}>
          <AddressCircle
            node={child.node}
            radius={child.radius}
            selected={selectedId === child.node.id}
            onActivate={() => onSelectNode(child.node.id)}
          />
        </g>
      ))}

      {/* Dashed ring means the machine was dropped here and is holding position. */}
      {pinned && <circle className="node-pin" r={radius + 4} />}
    </g>
  )
}
