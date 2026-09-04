import type { Point } from '@/hooks/useForceLayout'

interface EdgeLineProps {
  from: Point | null
  to: Point | null
  strokeWidth: number
  scanLike: boolean
  selected: boolean
  label: string
  onActivate: () => void
}

export function EdgeLine({
  from,
  to,
  strokeWidth,
  scanLike,
  selected,
  label,
  onActivate,
}: EdgeLineProps) {
  // A body has no coordinates until the simulation has ticked once, and a
  // dangling endpoint in a merged capture never gets any.
  if (from === null || to === null) return null

  const classes = ['edge']
  // A scan is nearly free in bytes and would otherwise be the thinnest line on
  // the canvas, so it is flagged regardless of width.
  if (scanLike) classes.push('edge-scan')
  if (selected) classes.push('edge-selected')

  const ends = { x1: from.x, y1: from.y, x2: to.x, y2: to.y }

  return (
    <g className={classes.join(' ')} aria-label={label}>
      {/* A two-pixel line is unclickable, so a fat invisible one takes the
          hits -- and gives a finger something to land on. */}
      <line className="edge-hit" {...ends} onClick={onActivate} />
      <line
        className="edge-line"
        {...ends}
        strokeWidth={selected ? strokeWidth + 2.5 : strokeWidth}
      />
    </g>
  )
}
