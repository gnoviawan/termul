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
  NodePosition,
  Port
} from '@shared/types/automation.types'
import { logFrontendError } from '@/lib/log-api'
import { CARD, hasSlots, OUTPUT_PORTS, SLOT_DEPTH, TRIGGER } from './ports'

export type CanvasNodeId = NodeId | typeof TRIGGER

/**
 * Edges whose ends both exist and whose port the source has. An edge to a
 * missing node or from a port the kind lacks is a validation issue
 * (`unknown_edge_endpoint`, `illegal_port`) the issue list names; the drawing
 * and the step list both leave it out.
 */
export function drawableEdges(graph: Graph): Edge[] {
  const ports = new Map<string, readonly Port[]>([[TRIGGER, OUTPUT_PORTS.trigger]])
  for (const node of graph.nodes) ports.set(node.id, OUTPUT_PORTS[node.spec.kind])
  return graph.edges.filter(
    (edge) => ports.has(edge.to) && edge.to !== TRIGGER && ports.get(edge.from)?.includes(edge.port)
  )
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
      CARD.height + (hasSlots(node.spec) ? SLOT_DEPTH : 0)
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
 * Steps in the order they first run: a step after all its parents, siblings
 * in input order, and a loop's whole body before what follows the loop.
 * Unreachable steps follow; steps a cycle holds back come last, in input order.
 */
export function stepOrder(graph: Graph): AutomationNode[] {
  const edges = drawableEdges(graph)
  const byId = new Map<CanvasNodeId, AutomationNode>(graph.nodes.map((node) => [node.id, node]))
  const index = new Map(graph.nodes.map((node, i) => [node.id as CanvasNodeId, i]))
  const indegree = new Map<CanvasNodeId, number>()
  for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  const order: CanvasNodeId[] = []
  const seen = new Set<CanvasNodeId>()

  // Breadth-first, except that a for_each drains its `item` body before
  // releasing its other children.
  const drain = (queue: CanvasNodeId[]): void => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      order.push(id)
      const children = edges
        .filter((edge) => edge.from === id)
        .sort((a, b) => (index.get(a.to) ?? 0) - (index.get(b.to) ?? 0))
      const release = (edge: Edge, into: CanvasNodeId[]): void => {
        const left = (indegree.get(edge.to) ?? 0) - 1
        indegree.set(edge.to, left)
        if (left === 0 && !seen.has(edge.to)) {
          seen.add(edge.to)
          into.push(edge.to)
        }
      }
      const body: CanvasNodeId[] = []
      for (const edge of children) if (edge.port === 'item') release(edge, body)
      drain(body)
      for (const edge of children) if (edge.port !== 'item') release(edge, queue)
    }
  }

  seen.add(TRIGGER)
  drain([TRIGGER])
  for (const node of graph.nodes) {
    if (seen.has(node.id) || (indegree.get(node.id) ?? 0) > 0) continue
    seen.add(node.id)
    drain([node.id])
  }
  for (const node of graph.nodes) if (!seen.has(node.id)) order.push(node.id)
  return order.flatMap((id) => byId.get(id) ?? [])
}
