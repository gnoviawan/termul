/**
 * What a `{{ … }}` hole may name, mirrored from the host: `template.rs`
 * (syntax and roots) and `graph::check_node` (which nodes a step may read).
 * The autocomplete offers exactly the references the host resolves for a
 * step; the dry run stays the authority.
 */

import type { Graph, NodeId } from '@shared/types/automation.types'
import { NODE_KIND_PRESENTATION } from '../../automation-format'
import { stepOrder } from '../layout'

/** `template::is_segment`: one dotted part of a reference path. */
const SEGMENT = /^[A-Za-z0-9_-]+$/

export type TemplateSuggestion = {
  /** The reference inside the braces, e.g. `nodes.fetch.output`. */
  path: string
  label: string
  detail: string
}

/** Node-to-node children; edges from the trigger or to a missing node are left out, as on the host. */
function children(graph: Graph): Map<string, string[]> {
  const ids = new Set<string>(graph.nodes.map((node) => node.id))
  const out = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to])
  }
  return out
}

function reach(starts: Iterable<string>, adjacency: Map<string, string[]>): Set<string> {
  const seen = new Set<string>()
  const queue = [...starts]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/** `graph::ancestors`: every node with a path to `id`. */
export function ancestors(graph: Graph, id: NodeId): Set<string> {
  const parents = new Map<string, string[]>()
  for (const [from, tos] of children(graph)) {
    for (const to of tos) parents.set(to, [...(parents.get(to) ?? []), from])
  }
  return reach([id], parents)
}

/** `graph::loop_bodies`: each for_each's `item` targets and everything they reach. */
function loopBodies(graph: Graph): Map<string, Set<string>> {
  const adjacency = children(graph)
  const ids = new Set<string>(graph.nodes.map((node) => node.id))
  const bodies = new Map<string, Set<string>>()
  for (const node of graph.nodes) {
    if (node.spec.kind !== 'for_each') continue
    const entries = graph.edges
      .filter((edge) => edge.from === node.id && edge.port === 'item' && ids.has(edge.to))
      .map((edge) => edge.to as string)
    bodies.set(node.id, new Set([...entries, ...reach(entries, adjacency)]))
  }
  return bodies
}

/**
 * The references `id`'s templates may use, in run order: the trigger, each
 * ancestor's output (an agent's object schema adds its fields), and, inside
 * a for_each body, that loop's `item` and `index`. A loop's own output is
 * not offered inside its body, where the host refuses it.
 */
export function templateScope(graph: Graph, id: NodeId): TemplateSuggestion[] {
  const before = ancestors(graph, id)
  const bodies = loopBodies(graph)
  const suggestions: TemplateSuggestion[] = [
    { path: 'trigger.kind', label: 'Trigger', detail: 'manual, scheduled or catch_up' },
    { path: 'trigger.scheduled_for', label: 'Trigger', detail: 'when the run was due (ms)' }
  ]
  for (const node of stepOrder(graph)) {
    if (node.id === id) continue
    const kind = NODE_KIND_PRESENTATION[node.spec.kind].label
    if (bodies.get(node.id)?.has(id)) {
      suggestions.push(
        { path: `nodes.${node.id}.item`, label: node.label, detail: 'the current item' },
        { path: `nodes.${node.id}.index`, label: node.label, detail: 'the current index, from 0' }
      )
      continue
    }
    if (!before.has(node.id)) continue
    suggestions.push({ path: `nodes.${node.id}.output`, label: node.label, detail: kind })
    const schema = node.spec.kind === 'agent' ? node.spec.output_schema : null
    if (schema?.type === 'object') {
      // A property whose name the host cannot write as a path segment is left out.
      for (const field of Object.keys(schema.properties ?? {}).filter((f) => SEGMENT.test(f))) {
        suggestions.push({
          path: `nodes.${node.id}.output.${field}`,
          label: node.label,
          detail: `${kind} · ${field}`
        })
      }
    }
  }
  return suggestions
}

const NODE_ID = /^[a-z][a-z0-9_]{0,31}$/

/** `template::parse_reference`: why a hole's path is refused, or null. */
function pathError(path: string): string | null {
  const segments = path.split('.')
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    return 'segments must be non-empty and use letters, digits, _ or -'
  }
  const [root, second, third, ...rest] = segments
  if (root === 'trigger') {
    return segments.length === 2 && (second === 'scheduled_for' || second === 'kind')
      ? null
      : 'trigger exposes only scheduled_for and kind'
  }
  if (root === 'nodes') {
    if (!['output', 'item', 'index'].includes(third ?? '')) {
      return 'use nodes.<id>.output[.field...], nodes.<loop>.item[.field...] or nodes.<loop>.index'
    }
    if (!NODE_ID.test(second) || second === 'trigger') return `${second} is not a step id`
    return third === 'index' && rest.length > 0 ? 'nodes.<loop>.index has no fields' : null
  }
  if (root === 'secrets') return segments.length === 2 ? null : 'use secrets.<NAME>'
  return 'root must be trigger, nodes or secrets'
}

/** `template::parse`: why the host would refuse `source`, or null. */
export function templateError(source: string): string | null {
  let rest = source
  while (true) {
    const open = rest.indexOf('{{')
    if (open < 0) return null
    const after = rest.slice(open + 2)
    const close = after.indexOf('}}')
    if (close < 0) return 'An opened {{ is never closed with }}'
    const path = after.slice(0, close).trim()
    const problem = pathError(path)
    if (problem) return `{{ ${path} }}: ${problem}`
    rest = after.slice(close + 2)
  }
}

/** An unclosed `{{` before the caret: where it starts and the path typed after it. */
export function openHole(text: string, caret: number): { start: number; query: string } | null {
  const head = text.slice(0, caret)
  const start = head.lastIndexOf('{{')
  if (start < 0) return null
  const query = head.slice(start + 2).trimStart()
  return /^[A-Za-z0-9_.-]*$/.test(query) ? { start, query } : null
}

/**
 * `text` with the hole at `start` filled with `path`, and the caret after it.
 * When the caret sits inside a hole that is already closed, the rest of its
 * path and its `}}` are replaced too, so editing a reference never leaves the
 * old tail behind.
 */
export function fillHole(
  text: string,
  caret: number,
  start: number,
  path: string
): { text: string; caret: number } {
  const closing = /^[A-Za-z0-9_.\-\s]*\}\}/.exec(text.slice(caret))
  const inserted = `{{ ${path} }}`
  return {
    text: text.slice(0, start) + inserted + text.slice(caret + (closing?.[0].length ?? 0)),
    caret: start + inserted.length
  }
}

export function matchSuggestions(
  scope: readonly TemplateSuggestion[],
  query: string
): TemplateSuggestion[] {
  const q = query.toLowerCase()
  return scope.filter(
    (suggestion) =>
      suggestion.path.toLowerCase().includes(q) || suggestion.label.toLowerCase().includes(q)
  )
}
