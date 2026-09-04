/**
 * Colour meaning is defined once as tokens in styles.css and referenced by
 * name; the swatches here are those same tokens, never inline hex.
 */
export function Legend() {
  return (
    <ul className="legend" aria-label="Legend">
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
    </ul>
  )
}
