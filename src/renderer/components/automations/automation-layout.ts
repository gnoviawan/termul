/**
 * Read-only diagram layout: a layered, top-to-bottom placement of the trigger
 * and the graph's nodes. Each node's rank is its longest path from the
 * trigger; rows are ordered by the mean position of their parents and
 * centered. The graph may carry validation issues (a cycle, an unreachable
 * node, an edge to a missing node), so every input lays out without throwing.
 */

import type { Graph, NodeId, Port } from '@shared/types/automation.types'

export const TRIGGER = 'trigger'
export type DiagramNodeId = NodeId | typeof TRIGGER

export interface LayoutMetrics {
  nodeWidth: number
  nodeHeight: number
  gapX: number
  gapY: number
}

export interface PlacedNode {
  id: DiagramNodeId
  rank: number
  /** Position within its row, left to right. */
  order: number
  /** Top-left corner. */
  x: number
  y: number
}

export interface PlacedEdge {
  from: DiagramNodeId
  to: NodeId
  port: Port
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface DiagramLayout {
  width: number
  height: number
  nodes: PlacedNode[]
  edges: PlacedEdge[]
}

export function layoutGraph(graph: Graph, metrics: LayoutMetrics): DiagramLayout {
  const ids: DiagramNodeId[] = [TRIGGER, ...graph.nodes.map((node) => node.id)]
  const known = new Set<DiagramNodeId>(ids)
  const edges = graph.edges.filter(
    (edge) => known.has(edge.from) && known.has(edge.to) && edge.to !== TRIGGER
  )
  const ranks = rankNodes(ids, edges)
  const rows = orderRows(ids, edges, ranks)

  const widest = Math.max(...rows.map((row) => row.length))
  const pitchX = metrics.nodeWidth + metrics.gapX
  const pitchY = metrics.nodeHeight + metrics.gapY
  const width = widest * pitchX - metrics.gapX
  const placed = new Map<DiagramNodeId, PlacedNode>()
  rows.forEach((row, rank) => {
    const inset = ((widest - row.length) * pitchX) / 2
    row.forEach((id, order) => {
      placed.set(id, { id, rank, order, x: inset + order * pitchX, y: rank * pitchY })
    })
  })

  const outgoing = new Map<DiagramNodeId, number>()
  const placedEdges = edges.map((edge): PlacedEdge => {
    const from = placed.get(edge.from) as PlacedNode
    const to = placed.get(edge.to) as PlacedNode
    const siblings = edges.filter((e) => e.from === edge.from).length
    const index = outgoing.get(edge.from) ?? 0
    outgoing.set(edge.from, index + 1)
    // Fan a node's outgoing edges across its bottom edge so ports stay apart.
    const spread = metrics.nodeWidth / (siblings + 1)
    return {
      from: edge.from,
      to: edge.to,
      port: edge.port,
      x1: from.x + spread * (index + 1),
      y1: from.y + metrics.nodeHeight,
      x2: to.x + metrics.nodeWidth / 2,
      y2: to.y
    }
  })

  return {
    width,
    height: rows.length * pitchY - metrics.gapY,
    nodes: ids.map((id) => placed.get(id) as PlacedNode),
    edges: placedEdges
  }
}

type LayoutEdge = { from: DiagramNodeId; to: DiagramNodeId }

/**
 * Longest path from the trigger (Kahn's order). A node with no parent sits on
 * rank 1; nodes left over by a cycle sit one rank below their deepest ranked
 * parent.
 */
function rankNodes(ids: DiagramNodeId[], edges: LayoutEdge[]): Map<DiagramNodeId, number> {
  const indegree = new Map<DiagramNodeId, number>(ids.map((id) => [id, 0]))
  for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)

  const rank = new Map<DiagramNodeId, number>([[TRIGGER, 0]])
  const queue = ids.filter((id) => indegree.get(id) === 0)
  for (const id of queue) if (!rank.has(id)) rank.set(id, 1)

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    for (const edge of edges) {
      if (edge.from !== id) continue
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(id) ?? 0) + 1))
      const left = (indegree.get(edge.to) ?? 0) - 1
      indegree.set(edge.to, left)
      if (left === 0) queue.push(edge.to)
    }
  }

  for (const id of ids) {
    if (queue.includes(id)) continue
    const parents = edges.filter((edge) => edge.to === id && queue.includes(edge.from))
    rank.set(id, Math.max(0, ...parents.map((edge) => rank.get(edge.from) ?? 0)) + 1)
  }
  return rank
}

/** Rows by rank, each ordered by the mean order of its parents, then input order. */
function orderRows(
  ids: DiagramNodeId[],
  edges: LayoutEdge[],
  ranks: Map<DiagramNodeId, number>
): DiagramNodeId[][] {
  const depth = Math.max(...ranks.values())
  const rows: DiagramNodeId[][] = Array.from({ length: depth + 1 }, () => [])
  for (const id of ids) rows[ranks.get(id) ?? 0].push(id)

  const position = new Map<DiagramNodeId, number>()
  return rows.map((row) => {
    const keyed = row.map((id, inputIndex) => {
      const parents = edges
        .filter((edge) => edge.to === id && position.has(edge.from))
        .map((edge) => position.get(edge.from) as number)
      const mean = parents.length
        ? parents.reduce((sum, p) => sum + p, 0) / parents.length
        : Number.POSITIVE_INFINITY
      return { id, mean, inputIndex }
    })
    // Parentless nodes (the trigger, an unreachable node) keep input order after the rest.
    keyed.sort((a, b) => (a.mean === b.mean ? a.inputIndex - b.inputIndex : a.mean - b.mean))
    // Normalize to the row's width so rows of different lengths compare.
    keyed.forEach(({ id }, order) => {
      position.set(id, (order + 0.5) / keyed.length)
    })
    return keyed.map(({ id }) => id)
  })
}
