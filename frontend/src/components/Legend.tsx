import { CollapseToggle } from '@/components/CollapseToggle'
import { useCollapsed } from '@/hooks/useCollapsed'

/**
 * Colour meaning is defined once as tokens in styles.css and referenced by
 * name; the swatches here are those same tokens, never inline hex.
 *
 * It collapses because it overlays the canvas: once you know what the colours
 * mean it is a card sitting on top of the graph you came to read. The header
 * stays, so what it is remains obvious and it can be brought back.
 */
export function Legend() {
  const [collapsed, toggle] = useCollapsed('legend')

  return (
    <section className="legend" aria-label="Legend">
      <div className="legend-head">
        <h2>Legend</h2>
        <CollapseToggle
          collapsed={collapsed}
          onToggle={toggle}
          controls="legend-items"
          label="the legend"
        />
      </div>

      <ul id="legend-items" hidden={collapsed}>
        <li>
          <span className="swatch swatch-host" />
          host address
        </li>
        <li>
          <span className="swatch swatch-router" />
          router address
        </li>
        <li>
          <span className="swatch swatch-external" />
          external address
        </li>
        <li>
          <span className="swatch swatch-machine" />
          machine, holding its addresses
        </li>
        <li>
          <span className="swatch-line swatch-scan" />
          scan-shaped conversation
        </li>
        <li className="legend-note">
          Address circle area = packets, line width = frame bytes.
          <br />A machine ring is sized to fit its addresses, not by volume.
        </li>
        <li className="legend-note">
          Click a machine, an address inside it, or a line to read what the capture says.
          Drag a machine to move it &mdash; its addresses and their lines come along, and it
          stays where you drop it; double-click to hand it back to the layout.
        </li>
        <li className="legend-note">
          Drag the background to pan and scroll to zoom. Zoom changes what you can see, never
          what a circle means. <strong>Fit</strong> frames every circle, wherever the layout
          put it.
        </li>
      </ul>
    </section>
  )
}
