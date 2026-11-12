/**
 * What a run says about each card and edge of its own graph. Pure: the run
 * view recomputes it from the step rows on every poll, and the canvas merges
 * the result through `reuseUnchanged`, so only cards whose status moved
 * re-render.
 */

import type {
  AutomationNode,
  AutomationRun,
  AutomationStep,
  NodeId,
  Port,
  StepStatus
} from '@shared/types/automation.types'
import type { FiredBy } from '../../automation-format'
import { loopBodies } from '../inspector/template-scope'
import { type CanvasNodeId, drawableEdges, edgeKey } from '../layout'
import { TRIGGER } from '../ports'

/** A step as the run shows it: `pending` before it has a row, `cancelled` when a cancel stopped it. */
export type StepView = StepStatus | 'pending' | 'cancelled'

/** How an edge took part: it fired, it fired into a step still at work, or it did not fire. */
export type EdgeRun = 'taken' | 'live' | 'not_taken'

/** What a card draws: its status, and on a for_each the iterations so far. */
export type CardRun = { status: StepView; loop?: { iterations: number; failed: number } }

export type LoopRun = {
  /** Status of each iteration, by index. */
  iterations: StepView[]
  failed: number
  /** The iteration body cards show: the one picked, else the latest. Null before the first. */
  picked: number | null
}

export type RunOverlay = {
  fired: FiredBy
  cards: Map<CanvasNodeId, CardRun>
  /** Keyed like the canvas edges, `from:port->to`. An edge with no entry has not been decided. */
  edges: Map<string, EdgeRun>
  loops: Map<NodeId, LoopRun>
  /** The for_each whose body holds each body step. */
  loopOf: Map<NodeId, NodeId>
  /** The row each card shows: a body step's row in its loop's picked iteration. */
  rows: Map<NodeId, AutomationStep>
}

/** `executor.rs` `CANCELLED`: the error a step stopped by a cancel records. */
const CANCELLED = 'cancelled'

const rowKey = (node: string, iteration: number | null): string => `${node}:${iteration ?? ''}`

function viewOf(row: AutomationStep | undefined): StepView {
  if (!row) return 'pending'
  return row.status === 'failed' && row.error === CANCELLED ? 'cancelled' : row.status
}

const settled = (view: StepView): boolean => !['pending', 'running', 'waiting'].includes(view)

/**
 * The port a settled row fired, derived the way the host replays a row
 * (`executor.rs` `replayed`): failed fires `error`, a condition fires
 * `true`/`false` from its result, the rest fire `out`. A skipped or
 * cancelled step fired nothing.
 */
function firedPort(row: AutomationStep, kind: string): Port | null {
  switch (viewOf(row)) {
    case 'failed':
      return 'error'
    case 'succeeded':
      if (kind !== 'condition') return 'out'
      return (row.output as { result?: unknown } | null)?.result === true ? 'true' : 'false'
    default:
      return null
  }
}

/** An iteration's status from its body rows; the loop's latest iteration runs until a row says otherwise. */
function iterationView(rows: AutomationStep[], latestOfRunningLoop: boolean): StepView {
  const views = rows.map(viewOf)
  for (const view of ['running', 'waiting', 'cancelled', 'failed'] as const) {
    if (views.includes(view)) return view
  }
  return latestOfRunningLoop ? 'running' : 'succeeded'
}

export function runOverlay(
  run: Pick<AutomationRun, 'graph' | 'status' | 'trigger' | 'scheduled_for'>,
  steps: readonly AutomationStep[],
  picks: Readonly<Record<string, number>>
): RunOverlay {
  const { graph } = run
  const byKey = new Map(steps.map((step) => [rowKey(step.node_id, step.iteration), step]))
  const loopOf = new Map<NodeId, NodeId>()
  for (const [loop, body] of loopBodies(graph)) {
    for (const id of body) loopOf.set(id as NodeId, loop as NodeId)
  }

  const loops = new Map<NodeId, LoopRun>()
  for (const node of graph.nodes) {
    if (node.spec.kind !== 'for_each') continue
    const body = steps.filter((step) => loopOf.get(step.node_id) === node.id)
    const count = Math.max(0, ...body.map((step) => (step.iteration ?? -1) + 1))
    const loopRunning = !settled(viewOf(byKey.get(rowKey(node.id, null))))
    const iterations = Array.from({ length: count }, (_, index) =>
      iterationView(
        body.filter((step) => step.iteration === index),
        loopRunning && index === count - 1
      )
    )
    const pick = picks[node.id]
    loops.set(node.id, {
      iterations,
      failed: iterations.filter((view) => view === 'failed').length,
      picked: count === 0 ? null : pick !== undefined && pick < count ? pick : count - 1
    })
  }

  const rows = new Map<NodeId, AutomationStep>()
  const cards = new Map<CanvasNodeId, CardRun>([
    [TRIGGER, { status: run.status === 'skipped' ? 'skipped' : 'succeeded' }]
  ])
  for (const node of graph.nodes) {
    const loop = loopOf.get(node.id)
    const picked = loop === undefined ? null : (loops.get(loop)?.picked ?? null)
    // A loop that ran no iteration leaves one `skipped` row per body step, outside any iteration.
    const row = byKey.get(rowKey(node.id, picked)) ?? byKey.get(rowKey(node.id, null))
    if (row) rows.set(node.id, row)
    const own = loops.get(node.id)
    cards.set(node.id, {
      status: viewOf(row),
      ...(own && {
        loop: { iterations: own.iterations.length, failed: own.failed }
      })
    })
  }

  const kindOf = new Map<string, string>(graph.nodes.map((node) => [node.id, node.spec.kind]))
  const edges = new Map<string, EdgeRun>()
  for (const edge of drawableEdges(graph)) {
    let fired: boolean | null
    if (edge.from === TRIGGER) fired = run.status !== 'skipped'
    else if (edge.port === 'item') {
      const loop = loops.get(edge.from)
      const loopView = cards.get(edge.from)?.status ?? 'pending'
      fired = (loop?.iterations.length ?? 0) > 0 ? true : settled(loopView) ? false : null
    } else {
      const row = rows.get(edge.from)
      const view = viewOf(row)
      fired =
        row && settled(view) ? firedPort(row, kindOf.get(edge.from) ?? '') === edge.port : null
    }
    if (fired === null) continue
    const target = cards.get(edge.to)?.status
    edges.set(
      edgeKey(edge),
      !fired ? 'not_taken' : target === 'running' || target === 'waiting' ? 'live' : 'taken'
    )
  }

  return { fired: { by: run.trigger, at: run.scheduled_for }, cards, edges, loops, loopOf, rows }
}

/**
 * The step a run opens on: the first failed one, else the first at work
 * (running or waiting), in `order`. A for_each only when no step in its
 * body explains it. Null when the run has neither: it opens on the trigger.
 */
export function openingStep(overlay: RunOverlay, order: readonly AutomationNode[]): NodeId | null {
  const groups: readonly (readonly StepView[])[] = [['failed'], ['running', 'waiting']]
  for (const wanted of groups) {
    const hits = order.filter((node) =>
      wanted.includes(overlay.cards.get(node.id)?.status ?? 'pending')
    )
    const hit = hits.find((node) => node.spec.kind !== 'for_each') ?? hits[0]
    if (hit) return hit.id
  }
  return null
}
