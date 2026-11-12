import type {
  AutomationLayout,
  AutomationNode,
  AutomationOp,
  Edge,
  Graph,
  NodeId,
  NodePosition,
  Port
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

/** Where a new step goes and what it hangs off. */
export type AddPlacement = {
  at: NodePosition
  /** Chain the new step after this port. */
  from?: { from: Edge['from']; port: Edge['port'] }
  /** Split this edge around the new step. */
  split?: Edge
}

/**
 * Adding `node` at `at`: after `from` when given, or into the middle of
 * `split` (the source keeps its port, the new step continues on its chain
 * port). The other cards stay where they are drawn.
 */
export function addGesture(
  graph: Graph,
  layout: AutomationLayout,
  node: AutomationNode,
  chain: Port | null,
  placement: AddPlacement
): { ops: AutomationOp[]; layout: LayoutPatch } {
  const ops: AutomationOp[] = [{ op: 'add_node', node }]
  const { from, split } = placement
  if (split) {
    ops.push(
      { op: 'disconnect', edge: split },
      { op: 'connect', edge: { from: split.from, port: split.port, to: node.id } }
    )
    if (chain) ops.push({ op: 'connect', edge: { from: node.id, port: chain, to: split.to } })
  } else if (from) {
    ops.push({ op: 'connect', edge: { from: from.from, port: from.port, to: node.id } })
  }
  return { ops, layout: { ...freezePatch(graph, layout), [node.id]: placement.at } }
}
