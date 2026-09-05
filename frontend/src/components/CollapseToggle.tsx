interface CollapseToggleProps {
  collapsed: boolean
  onToggle: () => void
  /** Id of the element this shows and hides, which stays in the DOM either way. */
  controls: string
  /** What is being collapsed, for the accessible name: "the legend". */
  label: string
}

/**
 * The one collapse control, shared by the legend and the details panel so the
 * two cannot drift apart on behaviour or on what a screen reader announces.
 */
export function CollapseToggle({ collapsed, onToggle, controls, label }: CollapseToggleProps) {
  return (
    <button
      type="button"
      className="collapse-toggle"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
      onClick={onToggle}
    >
      <span aria-hidden="true">{collapsed ? '+' : '\u2212'}</span>
    </button>
  )
}
