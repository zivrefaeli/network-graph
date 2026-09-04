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
  /**
   * A sub-circle inside a machine. It takes no pointer events at all, so a
   * click or a drag anywhere on the machine lands on the machine -- the
   * address is read from the panel, not picked off the canvas.
   */
  inert?: boolean
}

/**
 * One address, drawn at the origin of whatever group places it. Purely
 * presentational: whoever places it owns the interaction.
 *
 * Its radius comes from the shared sqrt scale, so the circle's *area* is the
 * packet count.
 */
export function AddressCircle({
  node,
  radius,
  selected,
  labelGap = 15,
  label,
  inert = false,
}: AddressCircleProps) {
  const text = label ?? node.label
  const classes = ['address', `address-${node.node_type}`]
  if (selected) classes.push('address-selected')
  if (inert) classes.push('address-inert')

  return (
    <g
      className={classes.join(' ')}
      aria-label={`${text}, ${node.node_type}, ${formatCount(nodePackets(node))} packets`}
    >
      {selected && <circle className="address-halo" r={radius + 6} />}
      <circle className="address-body" r={radius} />
      <text className="address-label" y={radius + labelGap}>
        {text}
      </text>
    </g>
  )
}
