import { CollapseToggle } from '@/components/CollapseToggle'
import { useCollapsed } from '@/hooks/useCollapsed'
import {
  durationSeconds,
  formatBytes,
  formatCount,
  formatDuration,
  formatTime,
} from '@/lib/format'
import { findEdge } from '@/lib/layout'
import { edgeFrameBytes, isScanLike, machinePackets, nodePackets } from '@/lib/scales'
import type {
  AddressId,
  CaptureDocument,
  GraphEdge,
  GraphNode,
  Hostname,
  Machine,
  MachineId,
  Selection,
  Traffic,
} from '@/types/graph'

const ARROW = '→'

interface RowProps {
  label: string
  children?: React.ReactNode
}

function Row({ label, children }: RowProps) {
  const empty = children === null || children === undefined || children === ''
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">
        {empty ? <span className="muted">not observed</span> : children}
      </span>
    </div>
  )
}

function TrafficBlock({ traffic, sizedBy }: { traffic: Traffic; sizedBy?: string }) {
  return (
    <section>
      <h3>Traffic</h3>
      <Row label="Packets sent">{formatCount(traffic.packets_sent)}</Row>
      <Row label="Packets received">{formatCount(traffic.packets_received)}</Row>
      {/* Labelled as frame bytes: payload_bytes is a different number and the
          two must never be summed. */}
      <Row label="Frame bytes sent">{formatBytes(traffic.frame_bytes_sent)}</Row>
      <Row label="Frame bytes received">{formatBytes(traffic.frame_bytes_received)}</Row>
      <Row label="Peers">{formatCount(traffic.peer_count)}</Row>
      {sizedBy !== undefined && <p className="note">{sizedBy}</p>}
    </section>
  )
}

function Hostnames({
  hostnames,
  confidence,
}: {
  hostnames: readonly Hostname[]
  // Null when nothing named it, which the backend sends explicitly.
  confidence?: number | null
}) {
  return (
    <section>
      {/* Inferred fields never render without their basis or confidence. */}
      <h3>
        Hostnames <span className="qualifier">inferred</span>
      </h3>
      {hostnames.length === 0 ? (
        <p className="muted">None observed.</p>
      ) : (
        hostnames.map((hostname) => (
          <div key={`${hostname.source}:${hostname.name}`} className="stack-item">
            <code>{hostname.name}</code>
            <span className="tag">{hostname.source}</span>
          </div>
        ))
      )}
      {confidence != null && (
        <Row label="Confidence">{`${Math.round(confidence * 100)}%`}</Row>
      )}
    </section>
  )
}

/**
 * A reference this document does not carry. Merged captures produce these
 * legitimately, so it is reported rather than hidden or crashed on.
 */
function Dangling({ id }: { id: string }) {
  return (
    <p className="alert alert-soft">
      <code>{id}</code> is referenced but is not in this document.
    </p>
  )
}

interface MachinePanelProps {
  machine: Machine
  doc: CaptureDocument
  onSelect: (selection: Selection) => void
}

function MachinePanel({ machine, doc, onSelect }: MachinePanelProps) {
  const props = machine.properties
  const resolved = machine.node_ids.map((id) => ({
    id,
    node: doc.nodes.find((node) => node.id === id),
  }))
  const present = resolved.filter(
    (entry): entry is { id: AddressId; node: GraphNode } => entry.node !== undefined,
  )

  return (
    <>
      <header className="panel-head">
        <span className="chip chip-machine">machine</span>
        <h2>{machine.label}</h2>
        <code className="panel-id">{machine.id}</code>
      </header>

      <section>
        <h3>Addresses</h3>
        {present.map(({ node }) => (
          <button
            key={node.id}
            type="button"
            className="link-item"
            onClick={() => onSelect({ kind: 'node', id: node.id })}
          >
            <code>{node.properties.address}</code>
            <span className="tag">IPv{node.properties.version}</span>
            <span className="tag">{node.properties.scope}</span>
            <span className="link-item-count">{formatCount(nodePackets(node))} pkt</span>
          </button>
        ))}
        {resolved
          .filter((entry) => entry.node === undefined)
          .map((entry) => (
            <Dangling key={entry.id} id={entry.id} />
          ))}
        {present.length === 0 && (
          <p className="muted">
            None. A host that only ever spoke ARP has a MAC and no address.
          </p>
        )}
        {present.length > 1 && (
          <p className="note">
            All of these are this one machine. The outer circle is a container sized to
            hold them, not to encode volume &mdash; the sub-circles carry that.
          </p>
        )}
      </section>

      <TrafficBlock
        traffic={props.traffic}
        sizedBy={
          present.length > 1
            ? undefined
            : `The circle is sized from ${formatCount(machinePackets(machine))} packets.`
        }
      />

      <Hostnames hostnames={props.hostnames} confidence={machine.inference?.hostname_confidence} />

      <section>
        <h3>Hardware</h3>
        <Row label="MAC">
          <code>{props.mac_address}</code>
        </Row>
        {props.mac_is_randomized && (
          <p className="alert alert-soft">
            Randomized MAC. It identifies this association rather than the device, so there
            is no vendor behind it, and a rotation mid-capture would legitimately appear as
            a second machine.
          </p>
        )}
        <Row label="Vendor">{props.vendor}</Row>
        <Row label="VLAN">{props.vlan_id}</Row>
        <Row label="On this network">{props.is_local ? 'yes' : 'no'}</Row>
      </section>

      <section>
        <h3>Seen</h3>
        <Row label="First">{formatTime(machine.first_seen)}</Row>
        <Row label="Last">{formatTime(machine.last_seen)}</Row>
      </section>
    </>
  )
}

interface NodePanelProps {
  node: GraphNode
  doc: CaptureDocument
  onSelect: (selection: Selection) => void
}

function NodePanel({ node, doc, onSelect }: NodePanelProps) {
  const props = node.properties
  const machineId = node.machine_id
  const machine =
    machineId === null ? undefined : doc.machines.find((entry) => entry.id === machineId)
  const bindings = node.inference?.machine_bindings ?? []

  return (
    <>
      <header className="panel-head">
        <span className={`chip chip-${node.node_type}`}>{node.node_type}</span>
        <h2>{props.address}</h2>
        <code className="panel-id">{node.id}</code>
      </header>

      <section>
        <h3>Machine</h3>
        {machine !== undefined ? (
          <button
            type="button"
            className="link-item"
            onClick={() => onSelect({ kind: 'machine', id: machine.id })}
          >
            <code>{machine.label}</code>
            <span className="tag">{machine.properties.mac_address}</span>
          </button>
        ) : machineId === null ? (
          <p className="muted">
            None. Past the gateway, every frame for this address carried the router MAC, so
            there is no hardware address to attribute to it.
          </p>
        ) : (
          <Dangling id={machineId} />
        )}
        {bindings.map((binding) => (
          <div key={`${binding.machine_id}:${binding.basis}:${binding.first_seen}`} className="stack-item">
            <span className="tag">{binding.basis}</span>
            <span className="muted">
              {Math.round(binding.confidence * 100)}% &middot; {formatTime(binding.first_seen)}
              {' – '}
              {formatTime(binding.last_seen)}
            </span>
          </div>
        ))}
        {bindings.length > 1 && (
          <p className="alert alert-soft">
            This address was seen at more than one MAC. That is DHCP reassignment, MAC
            randomization, or spoofing &mdash; all three are worth looking at, so every
            binding is kept rather than one being picked.
          </p>
        )}
      </section>

      <section>
        <h3>Address</h3>
        <Row label="Version">IPv{props.version}</Row>
        <Row label="Scope">{props.scope}</Row>
        <Row label="On this network">{props.is_local ? 'yes' : 'no'}</Row>
        <Row label="Basis">
          {node.inference?.is_local_basis != null ? (
            <code className="basis">{node.inference.is_local_basis}</code>
          ) : null}
        </Row>
      </section>

      <TrafficBlock
        traffic={props.traffic}
        sizedBy={`The circle is sized from ${formatCount(nodePackets(node))} packets.`}
      />

      <Hostnames hostnames={props.hostnames} />

      <section>
        <h3>Seen</h3>
        <Row label="First">{formatTime(node.first_seen)}</Row>
        <Row label="Last">{formatTime(node.last_seen)}</Row>
      </section>
    </>
  )
}

function EndpointName({ id, doc }: { id: AddressId; doc: CaptureDocument }) {
  const node = doc.nodes.find((entry) => entry.id === id)
  if (node === undefined) return <code>{id}</code>
  const machineId = node.machine_id
  const machine =
    machineId === null ? undefined : doc.machines.find((entry) => entry.id === machineId)
  return (
    <>
      {node.properties.address}
      {machine !== undefined && <span className="muted"> ({machine.label})</span>}
    </>
  )
}

function EdgePanel({ edge, doc }: { edge: GraphEdge; doc: CaptureDocument }) {
  const props = edge.properties
  const health = props.tcp_health
  const [aId, bId] = edge.endpoints
  const a = doc.nodes.find((node) => node.id === aId)
  const b = doc.nodes.find((node) => node.id === bId)
  const sameMachine =
    a !== undefined && b !== undefined && a.machine_id !== null && a.machine_id === b.machine_id

  return (
    <>
      <header className="panel-head">
        <span className="chip chip-edge">{edge.layer} conversation</span>
        <h2>
          {a?.properties.address ?? aId} <span className="muted">and</span>{' '}
          {b?.properties.address ?? bId}
        </h2>
        <code className="panel-id">{edge.id}</code>
      </header>

      {a === undefined && <Dangling id={aId} />}
      {b === undefined && <Dangling id={bId} />}

      {sameMachine && (
        <p className="alert alert-soft">
          Both addresses belong to the same machine, so this conversation is drawn inside
          one circle.
        </p>
      )}

      {health !== null && isScanLike(edge) && (
        <p className="alert">
          {formatCount(health.syn_count)} SYNs answered by{' '}
          {formatCount(health.syn_ack_count)} SYN/ACKs across{' '}
          {formatCount(props.flow_count)} flows, carrying no payload at all. That is a
          scan, not a conversation.
        </p>
      )}

      <section>
        {/* Both directions, never a single merged total: "who sent 4 GB to
            whom" is the question this tool answers. */}
        <h3>Volume by direction</h3>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Packets</th>
                <th>On wire</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <EndpointName id={aId} doc={doc} /> {ARROW}{' '}
                  <EndpointName id={bId} doc={doc} />
                </td>
                <td>{formatCount(props.forward.packets)}</td>
                <td>{formatBytes(props.forward.frame_bytes)}</td>
                <td>{formatBytes(props.forward.payload_bytes)}</td>
              </tr>
              <tr>
                <td>
                  <EndpointName id={bId} doc={doc} /> {ARROW}{' '}
                  <EndpointName id={aId} doc={doc} />
                </td>
                <td>{formatCount(props.reverse.packets)}</td>
                <td>{formatBytes(props.reverse.frame_bytes)}</td>
                <td>{formatBytes(props.reverse.payload_bytes)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Row label="Total on wire">{formatBytes(edgeFrameBytes(edge))}</Row>
        <Row label="Flows">{formatCount(props.flow_count)}</Row>
        <Row label="Window">
          {formatTime(edge.first_seen)} for{' '}
          {formatDuration(durationSeconds(edge.first_seen, edge.last_seen))}
        </Row>
      </section>

      <section>
        <h3>Services</h3>
        {props.services.length === 0 ? (
          <p className="muted">No server-side port identified.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Protocols</th>
                  <th>Packets</th>
                  <th>On wire</th>
                  <th>Flows</th>
                </tr>
              </thead>
              <tbody>
                {props.services.map((service) => (
                  <tr key={`${service.transport}/${service.port}`}>
                    <td>
                      {/* transport disambiguates: TCP/53 and UDP/53 are
                          different services. */}
                      <code>
                        {service.transport}/{service.port}
                      </code>
                    </td>
                    <td>
                      {service.l7_protocols.length > 0 ? (
                        service.l7_protocols.join(', ')
                      ) : (
                        <span className="muted">none identified</span>
                      )}
                    </td>
                    <td>{formatCount(service.packets)}</td>
                    <td>{formatBytes(service.frame_bytes)}</td>
                    <td>{formatCount(service.flow_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3>TCP health</h3>
        {health === null ? (
          <p className="muted">No TCP in this conversation.</p>
        ) : (
          <>
            <Row label="SYN">{formatCount(health.syn_count)}</Row>
            <Row label="SYN/ACK">{formatCount(health.syn_ack_count)}</Row>
            <Row label="Resets">{formatCount(health.reset_count)}</Row>
            <Row label="Retransmissions">{formatCount(health.retransmission_count)}</Row>
            <Row label="Failed handshakes">
              <span className={health.failed_handshakes > 0 ? 'bad' : undefined}>
                {formatCount(health.failed_handshakes)}
              </span>
            </Row>
          </>
        )}
      </section>
    </>
  )
}

interface DetailsBodyProps {
  doc: CaptureDocument
  selection: NonNullable<Selection>
  onSelect: (selection: Selection) => void
}

function findMachine(doc: CaptureDocument, id: MachineId): Machine | undefined {
  return doc.machines.find((machine) => machine.id === id)
}

function DetailsBody({ doc, selection, onSelect }: DetailsBodyProps) {
  if (selection.kind === 'machine') {
    const machine = findMachine(doc, selection.id)
    if (machine === undefined) return <Dangling id={selection.id} />
    return <MachinePanel machine={machine} doc={doc} onSelect={onSelect} />
  }

  if (selection.kind === 'node') {
    const node = doc.nodes.find((entry) => entry.id === selection.id)
    if (node === undefined) return <Dangling id={selection.id} />
    return <NodePanel node={node} doc={doc} onSelect={onSelect} />
  }

  const edge = findEdge(doc, selection.id)
  if (edge === undefined) return <Dangling id={selection.id} />
  return <EdgePanel edge={edge} doc={doc} />
}

interface DetailsPanelProps {
  doc: CaptureDocument
  /**
   * Not nullable. App does not mount the panel with nothing selected, and this
   * type is what keeps the two in step -- the old empty state was 380px of
   * chrome whose only content was an explanation of itself.
   */
  selection: NonNullable<Selection>
  onSelect: (selection: Selection) => void
}

/**
 * Collapsible as well as conditional: with something selected there is a
 * reason to want the canvas back without giving up the selection to get it.
 * The rail keeps the panel addressable, so it is a fold rather than a close.
 */
export function DetailsPanel({ doc, selection, onSelect }: DetailsPanelProps) {
  const [collapsed, toggle] = useCollapsed('details')

  return (
    <aside className={`panel${collapsed ? ' panel-collapsed' : ''}`} aria-label="Details">
      <div className="panel-bar">
        <span className="panel-bar-title">Details</span>
        <CollapseToggle
          collapsed={collapsed}
          onToggle={toggle}
          controls="details-body"
          label="the details panel"
        />
      </div>

      <div id="details-body" hidden={collapsed}>
        <DetailsBody doc={doc} selection={selection} onSelect={onSelect} />
      </div>
    </aside>
  )
}
