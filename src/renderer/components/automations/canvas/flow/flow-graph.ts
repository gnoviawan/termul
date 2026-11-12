import type { Automation, Port } from '@shared/types/automation.types'
import { type Edge, type Node, type NodeHandle, Position } from '@xyflow/react'
import { type CanvasNodeId, drawableEdges, placeNodes } from '../layout'
import type { CardData } from '../nodes/NodeCard'
import { CARD, HANDLE_SIZE, INPUT_PORT_Y, OUTPUT_PORTS, outputPortY, TRIGGER } from '../ports'

export type CardNode = Node<CardData, 'card'>
export type PortEdge = Edge<{ port: Port }, 'port'>

/** Handle boxes relative to the card, so edges draw before the DOM is measured. */
function handlesOf(data: CardData): NodeHandle[] {
  const ports = OUTPUT_PORTS[data.kind === TRIGGER ? TRIGGER : data.node.spec.kind]
  const half = HANDLE_SIZE / 2
  const box = { width: HANDLE_SIZE, height: HANDLE_SIZE }
  const outputs = ports.map(
    (port, index): NodeHandle => ({
      id: port,
      type: 'source',
      position: Position.Right,
      x: CARD.width - half,
      y: outputPortY(index, ports.length) - half,
      ...box
    })
  )
  if (data.kind === TRIGGER) return outputs
  return [
    { id: 'in', type: 'target', position: Position.Left, x: -half, y: INPUT_PORT_Y - half, ...box },
    ...outputs
  ]
}

export function toFlow(automation: Pick<Automation, 'graph' | 'trigger' | 'layout'>): {
  nodes: CardNode[]
  edges: PortEdge[]
} {
  const { graph, trigger, layout } = automation
  const positions = placeNodes(graph, layout)
  const cards: [CanvasNodeId, CardData][] = [
    [TRIGGER, { kind: TRIGGER, trigger }],
    ...graph.nodes.map((node): [CanvasNodeId, CardData] => [node.id, { kind: 'step', node }])
  ]
  const nodes = cards.map(
    ([id, data]): CardNode => ({
      id,
      type: 'card',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: CARD.width,
      height: CARD.height,
      handles: handlesOf(data),
      data
    })
  )
  const edges = drawableEdges(graph).map(
    (edge): PortEdge => ({
      id: `${edge.from}:${edge.port}->${edge.to}`,
      type: 'port',
      source: edge.from,
      sourceHandle: edge.port,
      target: edge.to,
      targetHandle: 'in',
      selectable: false,
      data: { port: edge.port }
    })
  )
  return { nodes, edges }
}

/**
 * Keep the previous object whenever the host-owned fields are structurally
 * equal. The previous object also carries what React Flow added (`measured`,
 * `selected`), so reusing it skips a re-render and an edge remount and keeps
 * the selection across an `automation_changed` refresh.
 */
export function reuseUnchanged<T extends CardNode | PortEdge>(prev: T[], next: T[]): T[] {
  const byId = new Map(prev.map((item) => [item.id, item]))
  const own = (item: T): string => {
    const { id, type, source, target, sourceHandle, targetHandle, position, data } = item as T &
      Partial<CardNode> &
      Partial<PortEdge>
    return JSON.stringify([id, type, source, target, sourceHandle, targetHandle, position, data])
  }
  let same = prev.length === next.length
  const out = next.map((item, index) => {
    const old = byId.get(item.id)
    const equal = old !== undefined && own(old) === own(item)
    if (!equal || prev[index] !== old) same = false
    if (equal) return old
    return old === undefined ? item : ({ ...old, ...item } as T)
  })
  return same ? prev : out
}
