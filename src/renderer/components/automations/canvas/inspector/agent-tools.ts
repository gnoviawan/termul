/**
 * The host's rules on an agent step's tools, mirrored from `graph.rs`
 * (`check_agent_tools`, `untrusted_flow`) so the tool switches show them as
 * they are flipped. The dry run's issues stay the authority.
 */

import type { AgentTool, AutomationNode, Graph, NodeSpec } from '@shared/types/automation.types'
import { loopBodies, templateError } from './template-scope'

/** The switches, in the host's `AgentTool` order. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  'read',
  'search',
  'edit',
  'execute',
  'fetch',
  'other'
]

/** `AgentTool::reaches_out`: can send data out and bring untrusted data in. */
const reachesOut = (tool: AgentTool): boolean =>
  tool === 'execute' || tool === 'fetch' || tool === 'other'

/** `AgentTool::touches_files`. */
const touchesFiles = (tool: AgentTool): boolean =>
  tool === 'read' || tool === 'search' || tool === 'edit'

/** `NodeSpec::templates`: every template a step renders. */
function templates(spec: NodeSpec): string[] {
  switch (spec.kind) {
    case 'http':
      return [spec.url, ...spec.headers.map((h) => h.value), ...(spec.body ? [spec.body] : [])]
    case 'agent':
      return [spec.prompt]
    case 'transform':
      return spec.fields.map((f) => f.value)
    case 'condition':
      return [spec.left, ...(spec.right ? [spec.right] : [])]
    case 'fail':
    case 'approval':
      return [spec.message]
    case 'for_each':
      return [spec.items]
    case 'merge':
    case 'wait':
      return []
    case 'mcp_tool':
      return spec.arguments.map((a) => a.value)
  }
}

type Reference = { root: 'output' | 'item'; node: string }

const HOLE = /\{\{\s*nodes\.([a-z][a-z0-9_]{0,31})\.(output|item)\b[^}]*\}\}/g

/**
 * `graph::references`, narrowed to what the data flow reads: step outputs and
 * loop items. Like the host, a template it would refuse adds nothing.
 */
function references(spec: NodeSpec): Reference[] {
  return templates(spec)
    .filter((template) => templateError(template) === null)
    .flatMap((template) =>
      [...template.matchAll(HOLE)].map(([, node, root]) => ({
        node,
        root: root as Reference['root']
      }))
    )
}

/** `graph::data_sources`: the steps whose output flows into `node`'s. */
function dataSources(
  graph: Graph,
  bodies: Map<string, Set<string>>,
  node: AutomationNode
): string[] {
  const out: string[] = []
  for (const reference of references(node.spec)) {
    if (reference.root === 'output') {
      out.push(reference.node)
      continue
    }
    const loop = graph.nodes.find((candidate) => candidate.id === reference.node)
    if (loop) {
      out.push(
        ...references(loop.spec)
          .filter((r) => r.root === 'output')
          .map((r) => r.node)
      )
    }
  }
  if (node.spec.kind === 'merge') {
    out.push(
      ...graph.edges.filter((e) => e.to === node.id && e.from !== 'trigger').map((e) => e.from)
    )
  }
  if (node.spec.kind === 'for_each') out.push(...(bodies.get(node.id) ?? []))
  return out
}

/** `graph::untrusted_outputs`: steps whose output carries untrusted content. */
function untrustedOutputs(graph: Graph, bodies: Map<string, Set<string>>): Set<string> {
  const sources = new Map(graph.nodes.map((n) => [n.id, dataSources(graph, bodies, n)]))
  const tainted = new Set<string>(
    graph.nodes
      .filter(
        (n) =>
          n.spec.kind === 'http' ||
          n.spec.kind === 'mcp_tool' ||
          (n.spec.kind === 'agent' && n.spec.tools.some(reachesOut))
      )
      .map((n) => n.id)
  )
  for (let before = -1; before !== tainted.size; ) {
    before = tainted.size
    for (const node of graph.nodes) {
      if (sources.get(node.id)?.some((source) => tainted.has(source))) tainted.add(node.id)
    }
  }
  return tainted
}

/** `graph::descendants`: like the host's `children`, an edge to a missing step leads nowhere. */
function descendants(graph: Graph, id: string): Set<string> {
  const ids = new Set<string>(graph.nodes.map((node) => node.id))
  const seen = new Set<string>()
  const queue = [id]
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const edge of graph.edges) {
      if (edge.from !== at || !ids.has(edge.to) || seen.has(edge.to)) continue
      seen.add(edge.to)
      queue.push(edge.to)
    }
  }
  return seen
}

/** `graph::downstream`: what runs after `id`, past its loop when it sits in one. */
function downstream(graph: Graph, bodies: Map<string, Set<string>>, id: string): Set<string> {
  const out = descendants(graph, id)
  for (const [loop, body] of bodies) {
    if (body.has(id)) for (const after of descendants(graph, loop)) out.add(after)
  }
  return out
}

export type AgentToolRules = {
  /** `untrusted_agent_outbound_tool`: the prompt reads untrusted data, so these may not be on. */
  untrustedPrompt: AgentTool[]
  /** `outbound_agent_file_tool`: these take in untrusted data, so `files` may not be on. */
  outboundFiles: { outbound: AgentTool[]; files: AgentTool[] } | null
  /** `untrusted_flow` for this agent: it reads untrusted data and a later http or MCP tool step acts. */
  untrustedFlow: boolean
}

/** What the host says about `tools` on agent step `id` in `graph`. */
export function agentToolRules(
  graph: Graph,
  id: string,
  tools: readonly AgentTool[]
): AgentToolRules {
  const node = graph.nodes.find((n) => n.id === id)
  if (node?.spec.kind !== 'agent') {
    return { untrustedPrompt: [], outboundFiles: null, untrustedFlow: false }
  }
  // The rules run on the graph as it will be once these tools are saved.
  const withTools = { ...node, spec: { ...node.spec, tools: [...tools] } }
  const next = { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? withTools : n)) }
  const bodies = loopBodies(next)
  const tainted = untrustedOutputs(next, bodies)
  const promptUntrusted = dataSources(next, bodies, withTools).some((s) => tainted.has(s))

  const outbound = tools.filter((t) => reachesOut(t) && t !== 'execute')
  const files = tools.filter(touchesFiles)
  const reads = promptUntrusted || tools.some(reachesOut)
  return {
    untrustedPrompt: promptUntrusted ? tools.filter((t) => reachesOut(t) || t === 'edit') : [],
    outboundFiles: outbound.length > 0 && files.length > 0 ? { outbound, files } : null,
    untrustedFlow:
      reads &&
      [...downstream(next, bodies, id)].some((d) => {
        const kind = next.nodes.find((n) => n.id === d)?.spec.kind
        return kind === 'http' || kind === 'mcp_tool'
      })
  }
}
