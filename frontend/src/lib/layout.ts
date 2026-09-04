import { makeRadiusScale } from '@/lib/scales'
import type {
  AddressId,
  CaptureDocument,
  EdgeId,
  GraphEdge,
  GraphNode,
  Machine,
  MachineId,
  NodeId,
} from '@/types/graph'

// Clearance between adjacent sub-circles, and between a sub-circle and the
// wall of the machine that contains it.
const CHILD_GAP = 10
const CONTAINER_PAD = 7

/** One address drawn inside a machine, at a fixed offset from its centre. */
export interface PlacedChild {
  node: GraphNode
  dx: number
  dy: number
  radius: number
}

/**
 * A body is one object the force simulation moves. Addresses inside a machine
 * are deliberately *not* bodies -- see buildLayout.
 */
export type Body =
  | {
      kind: 'machine'
      id: MachineId
      machine: Machine
      radius: number
      /**
       * True only with more than one address. One child inside one parent is
       * noise, so a single-address machine draws as a plain circle and stays
       * volume-honest; an expanded machine's circle is a container sized to
       * fit its children and must never be read as encoding volume.
       */
      expanded: boolean
      children: readonly PlacedChild[]
    }
  | {
      kind: 'address'
      id: AddressId
      node: GraphNode
      radius: number
      expanded: false
      children: readonly []
    }

export interface Placement {
  bodyId: NodeId
  dx: number
  dy: number
  radius: number
}

export interface Layout {
  bodies: readonly Body[]
  /** Where to draw each address: which body, and the offset within it. */
  placement: Readonly<Record<string, Placement | undefined>>
  radiusFor: (node: GraphNode) => number
  nodeById: Readonly<Record<string, GraphNode | undefined>>
  machineById: Readonly<Record<string, Machine | undefined>>
  edgeById: Readonly<Record<string, GraphEdge | undefined>>
}

/**
 * Turns a capture document into the things the canvas actually draws.
 *
 * Only machines and unparented addresses become bodies. Addresses inside a
 * machine are placed on a ring relative to their parent, which is what makes
 * them -- and the edges that terminate on them -- ride along for free when the
 * machine is dragged. There is no second simulation to keep in sync.
 */
export function buildLayout(doc: CaptureDocument): Layout {
  const radiusFor = makeRadiusScale(doc.nodes)

  const nodeById: Record<string, GraphNode | undefined> = {}
  for (const node of doc.nodes) nodeById[node.id] = node

  const machineById: Record<string, Machine | undefined> = {}
  for (const machine of doc.machines) machineById[machine.id] = machine

  const edgeById: Record<string, GraphEdge | undefined> = {}
  for (const edge of doc.edges) edgeById[edge.id] = edge

  const bodies: Body[] = []
  const placement: Record<string, Placement | undefined> = {}

  for (const machine of doc.machines) {
    // A node_id that resolves to nothing is a dangling reference, which is a
    // real condition in merged captures. It is dropped here and reported by
    // the panel rather than crashing the render.
    const children = machine.node_ids
      .map((id) => nodeById[id])
      .filter((node): node is GraphNode => node !== undefined)
    if (children.length === 0) continue

    const radii = children.map(radiusFor)
    const ring = ringRadius(radii)
    const widest = Math.max(...radii)
    const first = radii[0] ?? 0
    const bodyRadius = children.length === 1 ? first : ring + widest + CONTAINER_PAD

    const placed: PlacedChild[] = children.map((node, i) => {
      // Start at the top and go clockwise. With two children that reads as one
      // above the other, which keeps both labels legible.
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / children.length
      const dx = children.length === 1 ? 0 : ring * Math.cos(angle)
      const dy = children.length === 1 ? 0 : ring * Math.sin(angle)
      const radius = radii[i] ?? first
      placement[node.id] = { bodyId: machine.id, dx, dy, radius }
      return { node, dx, dy, radius }
    })

    bodies.push({
      kind: 'machine',
      id: machine.id,
      machine,
      radius: bodyRadius,
      expanded: children.length > 1,
      children: placed,
    })
  }

  for (const node of doc.nodes) {
    // An address with no observed binding, or one naming a machine this
    // document does not carry, stands on its own. Never invent a parent.
    if (node.machine_id !== null && machineById[node.machine_id] !== undefined) continue
    const radius = radiusFor(node)
    placement[node.id] = { bodyId: node.id, dx: 0, dy: 0, radius }
    bodies.push({ kind: 'address', id: node.id, node, radius, expanded: false, children: [] })
  }

  return { bodies, placement, radiusFor, nodeById, machineById, edgeById }
}

/**
 * Radius of the ring the children sit on: big enough that no two neighbours
 * touch. The chord between adjacent children on a ring of radius R is
 * 2*R*sin(pi/n), so solve that for the pair that needs the most room.
 */
export function ringRadius(radii: readonly number[]): number {
  const n = radii.length
  if (n < 2) return 0
  const spread = 2 * Math.sin(Math.PI / n)
  let needed = 0
  for (let i = 0; i < n; i += 1) {
    const here = radii[i] ?? 0
    const next = radii[(i + 1) % n] ?? 0
    needed = Math.max(needed, (here + next + CHILD_GAP) / spread)
  }
  return needed
}

/** The body an address is drawn inside -- what the link force actually pulls. */
export function bodyIdOf(layout: Layout, addressId: AddressId): NodeId | undefined {
  return layout.placement[addressId]?.bodyId
}

/** Every edge that terminates on a given address. */
export function edgesForAddress(
  doc: CaptureDocument,
  addressId: AddressId,
): readonly GraphEdge[] {
  return doc.edges.filter(
    (edge) => edge.endpoints[0] === addressId || edge.endpoints[1] === addressId,
  )
}

/** The other end of an edge, from one address's point of view. */
export function peerOf(edge: GraphEdge, addressId: AddressId): AddressId | undefined {
  if (edge.endpoints[0] === addressId) return edge.endpoints[1]
  if (edge.endpoints[1] === addressId) return edge.endpoints[0]
  return undefined
}

export function findEdge(doc: CaptureDocument, id: EdgeId): GraphEdge | undefined {
  return doc.edges.find((edge) => edge.id === id)
}
