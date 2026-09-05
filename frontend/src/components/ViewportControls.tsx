interface ViewportControlsProps {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onReset: () => void
}

/**
 * The keyboard path to the canvas.
 *
 * Pan and zoom are pointer gestures, and a graph that can only be driven by
 * mouse is not shippable -- Fit in particular is the answer to "a circle is
 * off screen and I cannot reach it". These are real buttons, so they are in
 * the tab order and activate on Enter and Space without any of it being
 * reimplemented here.
 */
export function ViewportControls({
  onZoomIn,
  onZoomOut,
  onFit,
  onReset,
}: ViewportControlsProps) {
  return (
    <div className="viewport-controls" role="group" aria-label="View">
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut}>
        <span aria-hidden="true">&minus;</span>
      </button>
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn}>
        <span aria-hidden="true">+</span>
      </button>
      <button type="button" title="Frame every circle, wherever the layout put it" onClick={onFit}>
        Fit
      </button>
      <button type="button" title="Back to the starting view" onClick={onReset}>
        Reset
      </button>
    </div>
  )
}
