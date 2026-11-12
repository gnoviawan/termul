/**
 * The local mirror of `graph::apply_ops` (`src-tauri/src/automation/graph.rs`):
 * the same op semantics and the same rejections, so a gesture renders before
 * the host answers. `__fixtures__/automation-ops.json` is checked against both
 * sides. The host stays the authority: its dry run and Save decide.
 */

import type {
  Automation,
  AutomationOp,
  Edge,
  Graph,
  NodeId,
  Port
} from '@shared/types/automation.types'
import { OUTPUT_PORTS, TRIGGER } from '../ports'

/** What an op batch reads and writes. */
export type DraftDoc = Pick<Automation, 'name' | 'trigger' | 'graph' | 'isolation'>

/**
 * Why the host refuses a batch, as `OpError` names it. `invalid_node_id` is
 * the host's deserialization refusal (`NodeId::parse`), which never reaches
 * `apply_ops`.
 */
export type OpRejection =
  | { code: 'empty_batch' }
  | { code: 'node_exists' | 'node_not_found' | 'invalid_node_id'; index: number; id: string }
  | { code: 'edge_exists' | 'edge_not_found' | 'empty_name'; index: number }

export type ApplyResult = { ok: true; doc: DraftDoc } | { ok: false; rejection: OpRejection }

const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/

export function isNodeId(value: string): value is NodeId {
  return NODE_ID.test(value) && value !== TRIGGER
}

export function sameEdge(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.port === b.port && a.to === b.to
}

/** Every node id an op names, where the host parses it. */
function namedIds(op: AutomationOp): string[] {
  switch (op.op) {
    case 'add_node':
      return [op.node.id]
    case 'update_node':
    case 'remove_node':
      return [op.id]
    case 'connect':
    case 'disconnect':
      return op.edge.from === TRIGGER ? [op.edge.to] : [op.edge.from, op.edge.to]
    default:
      return []
  }
}

function applyOne(doc: DraftDoc, op: AutomationOp, index: number): ApplyResult {
  const bad = namedIds(op).find((id) => !isNodeId(id))
  if (bad !== undefined)
    return { ok: false, rejection: { code: 'invalid_node_id', index, id: bad } }
  const { graph } = doc
  const withGraph = (next: Graph): ApplyResult => ({ ok: true, doc: { ...doc, graph: next } })
  switch (op.op) {
    case 'add_node':
      if (graph.nodes.some((node) => node.id === op.node.id)) {
        return { ok: false, rejection: { code: 'node_exists', index, id: op.node.id } }
      }
      return withGraph({ ...graph, nodes: [...graph.nodes, op.node] })
    case 'update_node': {
      if (!graph.nodes.some((node) => node.id === op.id)) {
        return { ok: false, rejection: { code: 'node_not_found', index, id: op.id } }
      }
      return withGraph({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === op.id
            ? { ...node, label: op.label ?? node.label, spec: op.spec ?? node.spec }
            : node
        )
      })
    }
    case 'remove_node':
      if (!graph.nodes.some((node) => node.id === op.id)) {
        return { ok: false, rejection: { code: 'node_not_found', index, id: op.id } }
      }
      return withGraph({
        nodes: graph.nodes.filter((node) => node.id !== op.id),
        edges: graph.edges.filter((edge) => edge.from !== op.id && edge.to !== op.id)
      })
    case 'connect':
      if (graph.edges.some((edge) => sameEdge(edge, op.edge))) {
        return { ok: false, rejection: { code: 'edge_exists', index } }
      }
      return withGraph({ ...graph, edges: [...graph.edges, op.edge] })
    case 'disconnect': {
      const at = graph.edges.findIndex((edge) => sameEdge(edge, op.edge))
      if (at === -1) return { ok: false, rejection: { code: 'edge_not_found', index } }
      return withGraph({ ...graph, edges: graph.edges.filter((_, i) => i !== at) })
    }
    case 'set_trigger':
      return { ok: true, doc: { ...doc, trigger: op.trigger } }
    case 'rename':
      if (op.name.trim() === '') return { ok: false, rejection: { code: 'empty_name', index } }
      return { ok: true, doc: { ...doc, name: op.name } }
    case 'set_isolation':
      return { ok: true, doc: { ...doc, isolation: op.isolation } }
  }
}

/** Applies the whole batch or nothing, like the host; `index` counts from 0 within the batch. */
export function applyOps(doc: DraftDoc, ops: readonly AutomationOp[]): ApplyResult {
  if (ops.length === 0) return { ok: false, rejection: { code: 'empty_batch' } }
  let next = doc
  for (const [index, op] of ops.entries()) {
    const result = applyOne(next, op, index)
    if (!result.ok) return result
    next = result.doc
  }
  return { ok: true, doc: next }
}

/**
 * Why the canvas refuses to draw `edge`, or null when it may. The host saves
 * any of these, but each comes back as an issue (`illegal_port`, `cycle`) or
 * an `edge_exists` rejection, so the canvas stops them at the gesture.
 */
export type ConnectRefusal = 'illegal_port' | 'duplicate_edge' | 'cycle' | 'unknown_node'

export function refuseConnect(graph: Graph, edge: Edge): ConnectRefusal | null {
  const kinds = new Map(graph.nodes.map((node) => [node.id as string, node.spec.kind]))
  const sourceKind = edge.from === TRIGGER ? TRIGGER : kinds.get(edge.from)
  if (sourceKind === undefined || !kinds.has(edge.to)) return 'unknown_node'
  if (!(OUTPUT_PORTS[sourceKind] as readonly Port[]).includes(edge.port)) return 'illegal_port'
  if (graph.edges.some((existing) => sameEdge(existing, edge))) return 'duplicate_edge'
  if (edge.from !== TRIGGER && reaches(graph, edge.to, edge.from)) return 'cycle'
  return null
}

/** Whether a path of edges leads from `start` to `goal` (a node reaches itself). */
function reaches(graph: Graph, start: string, goal: string): boolean {
  const seen = new Set<string>()
  const queue = [start]
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    if (id === goal) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const edge of graph.edges) if (edge.from === id) queue.push(edge.to)
  }
  return false
}
