import type {
  AutomationLayout,
  AutomationOp,
  Edge,
  Graph,
  NodeId,
  NodePosition
} from '@shared/types/automation.types'
import { placeNodes } from '../layout'
import { sameEdge } from './apply-op'
import type { LayoutPatch } from './draft'

/**
 * Stored positions for every card the canvas placed itself. A stored position
 * moves the dagre anchor of unplaced cards, so a gesture that stores one
 * freezes the rest where they are drawn.
 */
export function freezePatch(graph: Graph, layout: AutomationLayout): LayoutPatch {
  const patch: LayoutPatch = {}
  for (const [id, position] of placeNodes(graph, layout)) {
    if (!layout[id]) patch[id] = position
  }
  return patch
}

/** The positions a move stores, or null when no card actually moved. */
export function movePatch(
  graph: Graph,
  layout: AutomationLayout,
  moved: Record<string, NodePosition>
): LayoutPatch | null {
  const drawn = placeNodes(graph, layout)
  const changed = Object.entries(moved).filter(([id, at]) => {
    const was = drawn.get(id as NodeId)
    return was !== undefined && (was.x !== at.x || was.y !== at.y)
  })
  if (changed.length === 0) return null
  return { ...freezePatch(graph, layout), ...Object.fromEntries(changed) }
}

/**
 * Deleting cards and edges. `remove_node` drops a card's own edges, so only
 * other edges disconnect; the remaining cards stay where they are drawn.
 */
export function removeGesture(
  graph: Graph,
  layout: AutomationLayout,
  nodes: NodeId[],
  edges: Edge[]
): { ops: AutomationOp[]; layout: LayoutPatch } {
  const gone = new Set<string>(nodes)
  const ops: AutomationOp[] = [
    ...nodes.map((id): AutomationOp => ({ op: 'remove_node', id })),
    ...edges
      .filter((edge) => !gone.has(edge.from) && !gone.has(edge.to))
      .filter((edge) => graph.edges.some((existing) => sameEdge(existing, edge)))
      .map((edge): AutomationOp => ({ op: 'disconnect', edge }))
  ]
  return {
    ops,
    layout: { ...freezePatch(graph, layout), ...Object.fromEntries(nodes.map((id) => [id, null])) }
  }
}
