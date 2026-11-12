/**
 * Where each card sits on the canvas, and the order steps read in. The graph
 * may carry validation issues (a cycle, an unreachable node, an edge to a
 * missing node), so every input lays out without throwing.
 */

import dagre from '@dagrejs/dagre'
import type {
  AutomationLayout,
  AutomationNode,
  Edge,
  Graph,
  NodeId,
  NodePosition
} from '@shared/types/automation.types'
import { logFrontendError } from '@/lib/log-api'
import { CARD, hasSlots, SLOT_DEPTH, TRIGGER } from './ports'

export type CanvasNodeId = NodeId | typeof TRIGGER

/** Edges whose ends both exist; an edge to a missing node is a validation issue, not a line. */
export function drawableEdges(graph: Graph): Edge[] {
  const known = new Set<string>([TRIGGER, ...graph.nodes.map((node) => node.id)])
  return graph.edges.filter((edge) => known.has(edge.from) && known.has(edge.to))
}

/**
 * Top-left corner of every card: its stored position, else a left-to-right
 * dagre placement. An unplaced node keeps its dagre offset from its first
 * placed parent, so a step a chat agent added lands beside the step it follows.
 */
export function placeNodes(
  graph: Graph,
  stored: AutomationLayout
): Map<CanvasNodeId, NodePosition> {
  const ids: CanvasNodeId[] = [TRIGGER, ...graph.nodes.map((node) => node.id)]
  const placed = new Map<CanvasNodeId, NodePosition>()
  for (const id of ids) {
    const position = stored[id]
    if (position) placed.set(id, position)
  }
  if (placed.size === ids.length) return placed

  const edges = drawableEdges(graph)
  const auto = autoPlace(graph, edges)
  if (placed.size === 0) return auto

  const firstPlaced = ids.find((id) => placed.has(id)) as CanvasNodeId
  // Left to right, so a parent resolves before its children.
  const pending = ids
    .filter((id) => !placed.has(id))
    .sort((a, b) => (auto.get(a)?.x ?? 0) - (auto.get(b)?.x ?? 0))
  for (const id of pending) {
    const anchor =
      edges.find((edge) => edge.to === id && placed.has(edge.from))?.from ?? firstPlaced
    const from = placed.get(anchor) as NodePosition
    const own = auto.get(id) as NodePosition
    const theirs = auto.get(anchor) as NodePosition
    placed.set(id, { x: from.x + own.x - theirs.x, y: from.y + own.y - theirs.y })
  }
  return placed
}

function autoPlace(graph: Graph, edges: Edge[]): Map<CanvasNodeId, NodePosition> {
  const sizes: [CanvasNodeId, number][] = [
    [TRIGGER, CARD.height],
    ...graph.nodes.map((node): [CanvasNodeId, number] => [
      node.id,
      CARD.height + (hasSlots(node.spec.kind) ? SLOT_DEPTH : 0)
    ])
  ]
  try {
    const g = new dagre.graphlib.Graph({ multigraph: true })
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 64 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const [id, height] of sizes) g.setNode(id, { width: CARD.width, height })
    for (const edge of edges) g.setEdge(edge.from, edge.to, {}, edge.port)
    dagre.layout(g)
    // dagre reports centres; a card's slots hang below it, so its top sits half the stack up.
    return new Map(
      sizes.map(([id, height]) => {
        const { x, y } = g.node(id)
        return [id, { x: x - CARD.width / 2, y: y - height / 2 }]
      })
    )
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'automation-canvas:layout',
      message: `dagre could not lay out ${sizes.length} cards, falling back to one row: ${String(error)}`
    })
    return new Map(sizes.map(([id], index) => [id, { x: index * (CARD.width + 64), y: 0 }]))
  }
}

/**
 * Steps in the order they first run: a step after all its parents, a loop's
 * body before what follows the loop, siblings in input order. Unreachable
 * steps follow; steps a cycle holds back come last, in input order.
 */
export function stepOrder(graph: Graph): AutomationNode[] {
  const edges = drawableEdges(graph)
  const index = new Map(graph.nodes.map((node, i) => [node.id as CanvasNodeId, i]))
  const indegree = new Map<CanvasNodeId, number>()
  for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)

  const queue: CanvasNodeId[] = []
  const queued = new Set<CanvasNodeId>()
  const enqueue = (id: CanvasNodeId): void => {
    queue.push(id)
    queued.add(id)
  }
  let head = 0
  const drain = (): void => {
    for (; head < queue.length; head += 1) {
      const id = queue[head]
      const children = edges
        .filter((edge) => edge.from === id)
        .sort(
          (a, b) =>
            Number(b.port === 'item') - Number(a.port === 'item') ||
            (index.get(a.to) ?? 0) - (index.get(b.to) ?? 0)
        )
      for (const edge of children) {
        const left = (indegree.get(edge.to) ?? 0) - 1
        indegree.set(edge.to, left)
        if (left === 0 && !queued.has(edge.to)) enqueue(edge.to)
      }
    }
  }

  enqueue(TRIGGER)
  drain()
  for (const node of graph.nodes) {
    if (queued.has(node.id) || (indegree.get(node.id) ?? 0) > 0) continue
    enqueue(node.id)
    drain()
  }
  for (const node of graph.nodes) if (!queued.has(node.id)) enqueue(node.id)

  const byId = new Map<CanvasNodeId, AutomationNode>(graph.nodes.map((node) => [node.id, node]))
  return queue.flatMap((id) => byId.get(id) ?? [])
}
