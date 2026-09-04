import { formatCount } from '@/lib/format'
import { nodePackets } from '@/lib/scales'
import type { GraphNode } from '@/types/graph'

interface AddressCircleProps {
  node: GraphNode
  radius: number
  selected: boolean
  /** Overridden when the circle stands alone and its label needs more room. */
  labelGap?: number
  /** Shown instead of the address when the circle is wearing a machine name. */
  label?: string
  onActivate: () => void
}

/**
 * One address, drawn at the origin of whatever group places it.
 *
 * Its radius comes from the shared sqrt scale, so the circle's *area* is the
 * packet count. It is keyboard-reachable in its own right: a graph that can
 * only be driven by a mouse is not shippable.
 */
export function AddressCircle({
  node,
  radius,
  selected,
  labelGap = 15,
  label,
  onActivate,
}: AddressCircleProps) {
  const text = label ?? node.label
  const classes = ['address', `address-${node.node_type}`]
  if (selected) classes.push('address-selected')

  function handleKeyDown(event: React.KeyboardEvent<SVGGElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    // Otherwise the key also reaches the container behind it.
    event.stopPropagation()
    onActivate()
  }

  return (
    <g
      className={classes.join(' ')}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${text}, ${node.node_type}, ${formatCount(nodePackets(node))} packets`}
      onClick={(event) => {
        event.stopPropagation()
        onActivate()
      }}
      onKeyDown={handleKeyDown}
    >
      {selected && <circle className="address-halo" r={radius + 6} />}
      <circle className="address-body" r={radius} />
      <text className="address-label" y={radius + labelGap}>
        {text}
      </text>
    </g>
  )
}
