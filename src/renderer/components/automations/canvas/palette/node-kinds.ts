import type {
  AutomationNode,
  Graph,
  NodeId,
  NodeKind,
  NodeSpec,
  Port
} from '@shared/types/automation.types'
import { NODE_KIND_PRESENTATION } from '../../automation-format'
import { OUTPUT_PORTS } from '../ports'

export type PaletteGroup = 'Actions' | 'Logic' | 'Data'

/**
 * Every kind the add menu offers: its group and the spec a fresh node starts
 * with. Each spec deserializes on the host, so a new node always saves; empty
 * fields come back as issues to fill in, never as a refused batch. A new kind
 * is one entry here.
 */
export const NODE_KINDS: {
  [K in NodeKind]: { group: PaletteGroup; spec: () => Extract<NodeSpec, { kind: K }> }
} = {
  http: {
    group: 'Actions',
    spec: () => ({
      kind: 'http',
      method: 'GET',
      url: '',
      headers: [],
      body: null,
      allowed_hosts: []
    })
  },
  agent: {
    group: 'Actions',
    spec: () => ({
      kind: 'agent',
      agent_id: '',
      model: null,
      prompt: '',
      output_schema: { type: 'string' },
      timeout_ms: 120_000,
      max_attempts: 1,
      tools: []
    })
  },
  mcp_tool: {
    group: 'Actions',
    spec: () => ({ kind: 'mcp_tool', server_id: '', tool: '', arguments: [], timeout_ms: 60_000 })
  },
  condition: {
    group: 'Logic',
    spec: () => ({ kind: 'condition', left: '', op: 'eq', right: '' })
  },
  for_each: { group: 'Logic', spec: () => ({ kind: 'for_each', items: '', max_iterations: 10 }) },
  merge: { group: 'Logic', spec: () => ({ kind: 'merge', mode: 'any' }) },
  wait: { group: 'Logic', spec: () => ({ kind: 'wait', duration_ms: 60_000 }) },
  fail: { group: 'Logic', spec: () => ({ kind: 'fail', message: 'Stopped' }) },
  approval: {
    group: 'Logic',
    // The host accepts 1 minute to 7 days; a day leaves time to answer.
    spec: () => ({ kind: 'approval', message: 'Approve this run?', timeout_ms: 86_400_000 })
  },
  transform: { group: 'Data', spec: () => ({ kind: 'transform', fields: [] }) }
}

export const PALETTE_GROUPS: { label: PaletteGroup; kinds: NodeKind[] }[] = (
  ['Actions', 'Logic', 'Data'] as const
).map((label) => ({
  label,
  kinds: (Object.keys(NODE_KINDS) as NodeKind[]).filter((kind) => NODE_KINDS[kind].group === label)
}))

/** The port a step continues on when it is chained in: `out`, or `true` for a condition. */
export function chainPort(kind: NodeKind): Port | null {
  const ports = OUTPUT_PORTS[kind]
  return ports.includes('out') ? 'out' : (ports.find((port) => port !== 'error') ?? null)
}

/** A fresh node of `kind` with an id and label no other step of `graph` uses. */
export function newNode(kind: NodeKind, graph: Graph): AutomationNode {
  const ids = new Set<string>(graph.nodes.map((node) => node.id))
  const labels = new Set(graph.nodes.map((node) => node.label))
  let n = 1
  const idOf = (i: number) => (i === 1 ? kind : `${kind}_${i}`)
  const labelOf = (i: number) =>
    i === 1 ? NODE_KIND_PRESENTATION[kind].label : `${NODE_KIND_PRESENTATION[kind].label} ${i}`
  while (ids.has(idOf(n)) || labels.has(labelOf(n))) n += 1
  return { id: idOf(n) as NodeId, label: labelOf(n), spec: NODE_KINDS[kind].spec() }
}
