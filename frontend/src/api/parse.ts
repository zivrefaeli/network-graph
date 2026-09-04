import type {
  AddressId,
  CaptureDocument,
  EdgeId,
  GraphEdge,
  GraphNode,
  Machine,
  MachineId,
} from '@/types/graph'

// The boundary. Everything arriving from a file or the network is `unknown`
// until it has been through here, and this is the only place a raw string is
// allowed to become a namespaced id.
//
// This is deliberately not a general JSON-schema validator and no validation
// library is pulled in for it. It checks what is load-bearing -- the rules in
// README.md whose violation produces a misleading graph rather than a merely
// incomplete one -- and lets cosmetic fields fall through. If a document
// passes here and still renders wrong, that is a finding about this list.

export type ParseResult =
  | { ok: true; document: CaptureDocument }
  | { ok: false; errors: readonly string[] }

const SUPPORTED_SCHEMA_MAJOR = '2'

class Errors {
  private readonly messages: string[] = []

  add(where: string, message: string): void {
    // Ten identical complaints about a thousand-node document help no one.
    if (this.messages.length < 25) this.messages.push(`${where}: ${message}`)
  }

  get any(): boolean {
    return this.messages.length > 0
  }

  list(): readonly string[] {
    return this.messages
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCounter(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isMachineId(value: unknown): value is MachineId {
  return typeof value === 'string' && value.startsWith('mac:') && value.length > 4
}

function isAddressId(value: unknown): value is AddressId {
  return typeof value === 'string' && value.startsWith('ip:') && value.length > 3
}

function isEdgeId(value: unknown): value is EdgeId {
  return typeof value === 'string' && value.startsWith('edge_') && value.length > 5
}

const TRAFFIC_KEYS = [
  'packets_sent',
  'packets_received',
  'frame_bytes_sent',
  'frame_bytes_received',
  'peer_count',
] as const

function checkTraffic(value: unknown, where: string, errors: Errors): void {
  if (!isRecord(value)) {
    errors.add(where, 'traffic block is missing')
    return
  }
  for (const key of TRAFFIC_KEYS) {
    if (!isCounter(value[key])) {
      errors.add(where, `traffic.${key} must be a number >= 0`)
    }
  }
}

const COUNTER_KEYS = ['packets', 'frame_bytes', 'payload_bytes'] as const

function checkCounters(value: unknown, where: string, errors: Errors): void {
  if (!isRecord(value)) {
    errors.add(where, 'counter block is missing')
    return
  }
  for (const key of COUNTER_KEYS) {
    if (!isCounter(value[key])) {
      errors.add(where, `${key} must be a number >= 0`)
    }
  }
}

function checkMachine(value: unknown, index: number, errors: Errors): MachineId | undefined {
  const where = `machines[${index}]`
  if (!isRecord(value)) {
    errors.add(where, 'not an object')
    return undefined
  }
  if (!isMachineId(value['id'])) {
    errors.add(where, 'id must be namespaced as "mac:<address>"')
    return undefined
  }
  const nodeIds: unknown = value['node_ids']
  if (!Array.isArray(nodeIds)) {
    errors.add(where, 'node_ids must be an array (it may be empty)')
  } else {
    for (const id of nodeIds) {
      if (!isAddressId(id)) {
        errors.add(where, `node_ids contains ${JSON.stringify(id)}, which is not an "ip:" id`)
      }
    }
  }
  const props: unknown = value['properties']
  if (!isRecord(props)) {
    errors.add(where, 'properties is missing')
  } else {
    checkTraffic(props['traffic'], where, errors)
  }
  return value['id']
}

function checkNode(value: unknown, index: number, errors: Errors): AddressId | undefined {
  const where = `nodes[${index}]`
  if (!isRecord(value)) {
    errors.add(where, 'not an object')
    return undefined
  }
  if (!isAddressId(value['id'])) {
    errors.add(where, 'id must be namespaced as "ip:<address>"')
    return undefined
  }
  const machineId: unknown = value['machine_id']
  if (machineId !== null && !isMachineId(machineId)) {
    errors.add(where, 'machine_id must be a "mac:" id or null')
  }
  const props: unknown = value['properties']
  if (!isRecord(props)) {
    errors.add(where, 'properties is missing')
  } else {
    checkTraffic(props['traffic'], where, errors)
  }
  return value['id']
}

function checkEdge(value: unknown, index: number, errors: Errors): void {
  const where = `edges[${index}]`
  if (!isRecord(value)) {
    errors.add(where, 'not an object')
    return
  }
  if (!isEdgeId(value['id'])) {
    errors.add(where, 'id must start with "edge_"')
  }

  const layer: unknown = value['layer']
  if (layer !== 'l3' && layer !== 'l2') {
    errors.add(where, 'layer must be "l3" or "l2"')
  }

  const endpoints: unknown = value['endpoints']
  if (!Array.isArray(endpoints) || endpoints.length !== 2) {
    errors.add(where, 'endpoints must be a 2-item array')
  } else {
    const [a, b] = endpoints as readonly unknown[]
    if (layer === 'l3') {
      // The load-bearing rule. Every packet headed off the segment is
      // L2-addressed to the router, so an l3 edge terminating on a MAC
      // collapses the whole internet onto the gateway.
      if (!isAddressId(a) || !isAddressId(b)) {
        errors.add(where, 'an l3 edge must terminate on two "ip:" nodes, never a "mac:" id')
      }
    } else if (layer === 'l2') {
      // ARP, STP and LLDP have no IP header, so they have no address to
      // attach to. They are the only thing that may connect machines.
      if (!isMachineId(a) || !isMachineId(b)) {
        errors.add(where, 'an l2 edge must terminate on two "mac:" machines')
      }
    }
    if (typeof a === 'string' && typeof b === 'string' && a > b) {
      errors.add(where, `endpoints must be sorted; got ["${a}", "${b}"]`)
    }
  }

  const props: unknown = value['properties']
  if (!isRecord(props)) {
    errors.add(where, 'properties is missing')
    return
  }
  if (!isCounter(props['flow_count'])) {
    errors.add(where, 'flow_count must be a number >= 0')
  }
  checkCounters(props['forward'], `${where}.forward`, errors)
  checkCounters(props['reverse'], `${where}.reverse`, errors)
  if (!Array.isArray(props['services'])) {
    errors.add(where, 'services must be an array (it may be empty)')
  }
  const health: unknown = props['tcp_health']
  if (health !== null && health !== undefined && !isRecord(health)) {
    errors.add(where, 'tcp_health must be an object or null')
  }
}

/**
 * Narrow an unknown value -- a parsed JSON file, a fetched response body -- to
 * a CaptureDocument, or explain why it is not one.
 */
export function parseCaptureDocument(value: unknown): ParseResult {
  const errors = new Errors()

  if (!isRecord(value)) {
    return { ok: false, errors: ['document: not a JSON object'] }
  }

  const version: unknown = value['schema_version']
  if (typeof version !== 'string') {
    errors.add('document', 'schema_version is missing')
  } else if (!version.startsWith(`${SUPPORTED_SCHEMA_MAJOR}.`)) {
    errors.add(
      'document',
      `schema_version ${version} is not supported; this build reads ${SUPPORTED_SCHEMA_MAJOR}.x`,
    )
  }

  if (!isRecord(value['capture'])) {
    errors.add('document', 'capture block is missing')
  }

  const machines: unknown = value['machines']
  const nodes: unknown = value['nodes']
  const edges: unknown = value['edges']
  for (const [name, array] of [
    ['machines', machines],
    ['nodes', nodes],
    ['edges', edges],
  ] as const) {
    if (!Array.isArray(array)) errors.add('document', `${name} must be an array`)
  }
  if (errors.any) return { ok: false, errors: errors.list() }

  const machineIds = new Set<string>()
  ;(machines as readonly unknown[]).forEach((machine, i) => {
    const id = checkMachine(machine, i, errors)
    if (id !== undefined) {
      if (machineIds.has(id)) errors.add(`machines[${i}]`, `duplicate id ${id}`)
      machineIds.add(id)
    }
  })

  const nodeIds = new Set<string>()
  ;(nodes as readonly unknown[]).forEach((node, i) => {
    const id = checkNode(node, i, errors)
    if (id !== undefined) {
      if (nodeIds.has(id)) errors.add(`nodes[${i}]`, `duplicate id ${id}`)
      nodeIds.add(id)
    }
  })
  ;(edges as readonly unknown[]).forEach((edge, i) => {
    checkEdge(edge, i, errors)
  })

  // Cross-references. A dangling one is survivable at render time -- merged
  // captures produce them legitimately -- but it is worth saying out loud.
  ;(machines as readonly Partial<Machine>[]).forEach((machine, i) => {
    for (const id of machine.node_ids ?? []) {
      if (!nodeIds.has(id)) {
        errors.add(`machines[${i}]`, `node_ids names ${id}, which is not in nodes[]`)
      }
    }
  })
  ;(nodes as readonly Partial<GraphNode>[]).forEach((node, i) => {
    const machineId = node.machine_id
    if (machineId != null && !machineIds.has(machineId)) {
      errors.add(`nodes[${i}]`, `machine_id ${machineId} is not in machines[]`)
    }
  })
  ;(edges as readonly Partial<GraphEdge>[]).forEach((edge, i) => {
    if (edge.layer !== 'l3') return
    for (const endpoint of edge.endpoints ?? []) {
      if (!nodeIds.has(endpoint)) {
        errors.add(`edges[${i}]`, `endpoint ${endpoint} is not in nodes[]`)
      }
    }
  })

  if (errors.any) return { ok: false, errors: errors.list() }

  // Every check above has run; the shape is what CaptureDocument describes.
  return { ok: true, document: value as unknown as CaptureDocument }
}

/** Parse JSON text into a document, folding syntax errors into the same result. */
export function parseCaptureJson(text: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, errors: [`document: not valid JSON (${reason})`] }
  }
  return parseCaptureDocument(value)
}
