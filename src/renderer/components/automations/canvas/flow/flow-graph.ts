import type {
  Automation,
  Edge as AutomationEdge,
  Issue,
  Port
} from '@shared/types/automation.types'
import {
  type Edge,
  type Node,
  type NodeHandle,
  Position,
  type Rect,
  type Viewport
} from '@xyflow/react'
import { logFrontendError } from '@/lib/log-api'
import { type CanvasNodeId, drawableEdges, placeNodes } from '../layout'
import type { CardData } from '../nodes/NodeCard'
import {
  CARD,
  HANDLE_LABEL_WIDTH,
  HANDLE_SIZE,
  hasSlots,
  INPUT_PORT_Y,
  OUTPUT_PORTS,
  outputPortY,
  PORT_PRESENTATION,
  SLOT_DEPTH,
  TRIGGER
} from '../ports'

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

const edgeKey = (edge: AutomationEdge): string => `${edge.from}:${edge.port}->${edge.to}`
const warned = new Set<string>()

/** Each undrawable edge is logged once per session, not on every host refresh. */
function warnUndrawn(undrawn: AutomationEdge[]): void {
  const fresh = undrawn.map(edgeKey).filter((key) => !warned.has(key))
  if (fresh.length === 0) return
  for (const key of fresh) warned.add(key)
  void logFrontendError({
    level: 'warn',
    source: 'automation-canvas:edges',
    message: `not drawing ${fresh.length} edge(s) with a missing end or a port the step lacks: ${fresh.join(', ')}`
  })
}

/**
 * The box the drawing covers: each card plus what hangs outside its node
 * box, the config slots below and the `error` label to the right.
 */
export function contentBounds(nodes: CardNode[]): Rect {
  const rects = nodes.map(({ position, data }) => {
    const spec = data.kind === TRIGGER ? null : data.node.spec
    const ports = OUTPUT_PORTS[spec ? spec.kind : TRIGGER]
    const labelled = ports.some((port) => PORT_PRESENTATION[port].label === 'handle')
    return {
      x: position.x,
      y: position.y,
      x2: position.x + CARD.width + (labelled ? HANDLE_LABEL_WIDTH : 0),
      y2: position.y + CARD.height + (spec && hasSlots(spec) ? SLOT_DEPTH : 0)
    }
  })
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x2)) - x,
    height: Math.max(...rects.map((r) => r.y2)) - y
  }
}

/** Issue count per card; an issue that names no step belongs to the trigger. */
function issueCounts(issues: readonly Issue[]): Map<CanvasNodeId, number> {
  const counts = new Map<CanvasNodeId, number>()
  for (const issue of issues) {
    const card = issue.node_id ?? TRIGGER
    counts.set(card, (counts.get(card) ?? 0) + 1)
  }
  return counts
}

export function toFlow(
  automation: Pick<Automation, 'graph' | 'trigger' | 'layout'>,
  { issues = [], editing = false }: { issues?: readonly Issue[]; editing?: boolean } = {}
): {
  nodes: CardNode[]
  edges: PortEdge[]
} {
  const { graph, trigger, layout } = automation
  const positions = placeNodes(graph, layout)
  const counts = issueCounts(issues)
  const used = new Set(graph.edges.map((edge) => `${edge.from}:${edge.port}`))
  // Outputs with nothing behind them get a dangling "+" while editing; `error` is optional.
  const open = (id: CanvasNodeId, ports: readonly Port[]): Port[] =>
    editing ? ports.filter((port) => port !== 'error' && !used.has(`${id}:${port}`)) : []
  const cards: [CanvasNodeId, CardData][] = [
    [
      TRIGGER,
      {
        kind: TRIGGER,
        trigger,
        issues: counts.get(TRIGGER) ?? 0,
        open: open(TRIGGER, OUTPUT_PORTS.trigger)
      }
    ],
    ...graph.nodes.map((node): [CanvasNodeId, CardData] => [
      node.id,
      {
        kind: 'step',
        node,
        issues: counts.get(node.id) ?? 0,
        open: open(node.id, OUTPUT_PORTS[node.spec.kind])
      }
    ])
  ]
  const nodes = cards.map(
    ([id, data]): CardNode => ({
      id,
      type: 'card',
      position: positions.get(id) ?? { x: 0, y: 0 },
      width: CARD.width,
      height: CARD.height,
      handles: handlesOf(data),
      deletable: editing && id !== TRIGGER,
      data
    })
  )
  const drawn = drawableEdges(graph)
  if (drawn.length < graph.edges.length) warnUndrawn(graph.edges.filter((e) => !drawn.includes(e)))
  const edges = drawn.map(
    (edge): PortEdge => ({
      id: edgeKey(edge),
      type: 'port',
      source: edge.from,
      sourceHandle: edge.port,
      target: edge.to,
      targetHandle: 'in',
      selectable: editing,
      deletable: editing,
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

/**
 * The viewport that centres `card` in the part of a `width` x `height` canvas
 * left of `rightInset`, or null when the card (and the config slots an agent
 * or MCP tool card hangs below it) is already fully there.
 */
export function panToShow(
  card: Pick<CardNode, 'position' | 'data'>,
  viewport: Viewport,
  size: { width: number; height: number; rightInset: number }
): Viewport | null {
  const { x, y, zoom } = viewport
  const tall =
    CARD.height + (card.data.kind === 'step' && hasSlots(card.data.node.spec) ? SLOT_DEPTH : 0)
  const free = size.width - size.rightInset
  const left = card.position.x * zoom + x
  const top = card.position.y * zoom + y
  if (
    left >= 0 &&
    top >= 0 &&
    left + CARD.width * zoom <= free &&
    top + tall * zoom <= size.height
  ) {
    return null
  }
  return {
    zoom,
    x: free / 2 - (card.position.x + CARD.width / 2) * zoom,
    y: size.height / 2 - (card.position.y + tall / 2) * zoom
  }
}
