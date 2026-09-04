import type { GraphEdge, GraphNode, Machine } from '@/types/graph'

// Visual scales, shared by the canvas and the panel so a circle and its
// readout can never disagree. Every size mapping in the app goes through this
// file; no component computes its own.

const NODE_MIN_R = 12
const NODE_MAX_R = 34
const EDGE_MIN_W = 1.5
const EDGE_MAX_W = 9

export function nodePackets(node: GraphNode): number {
  const t = node.properties.traffic
  return t.packets_sent + t.packets_received
}

export function machinePackets(machine: Machine): number {
  const t = machine.properties.traffic
  return t.packets_sent + t.packets_received
}

/** On-the-wire bytes in both directions. Never summed with payload_bytes. */
export function edgeFrameBytes(edge: GraphEdge): number {
  const p = edge.properties
  return p.forward.frame_bytes + p.reverse.frame_bytes
}

/**
 * Area tracks volume, not radius: a host with four times the packets should
 * look four times bigger, so the radius grows with the square root. Scaling
 * the radius directly would make it sixteen times bigger and read as a lie.
 */
function sqrtScale(values: readonly number[], outMin: number, outMax: number) {
  const roots = values.map((value) => Math.sqrt(Math.max(value, 0)))
  const lo = roots.length > 0 ? Math.min(...roots) : 0
  const hi = roots.length > 0 ? Math.max(...roots) : 0
  const span = hi - lo
  return (value: number): number => {
    // One data point, or every point identical: there is no spread to encode,
    // so sit in the middle rather than dividing by zero.
    if (span === 0) return (outMin + outMax) / 2
    const t = (Math.sqrt(Math.max(value, 0)) - lo) / span
    return outMin + t * (outMax - outMin)
  }
}

export function makeRadiusScale(nodes: readonly GraphNode[]): (node: GraphNode) => number {
  const scale = sqrtScale(nodes.map(nodePackets), NODE_MIN_R, NODE_MAX_R)
  return (node) => scale(nodePackets(node))
}

export function makeWidthScale(edges: readonly GraphEdge[]): (edge: GraphEdge) => number {
  const scale = sqrtScale(edges.map(edgeFrameBytes), EDGE_MIN_W, EDGE_MAX_W)
  return (edge) => scale(edgeFrameBytes(edge))
}

/**
 * Plenty of SYNs and not one SYN/ACK: the port-scan shape README.md asks the
 * UI to surface. A scan is nearly free in bytes, so byte-weighted line width
 * would draw it as the thinnest line on the canvas and hide it. It gets
 * flagged distinctly regardless of width.
 */
export function isScanLike(edge: GraphEdge): boolean {
  const health = edge.properties.tcp_health
  if (health === null) return false
  return health.syn_count > 0 && health.syn_ack_count === 0
}
