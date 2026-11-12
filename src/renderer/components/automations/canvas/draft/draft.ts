/**
 * The canvas draft: a host head plus the steps applied on top of it since.
 * Nothing reaches the host revision until Save sends every pending op as one
 * `apply_ops` batch and the positions through `set_layout`.
 *
 * Undo and redo walk gestures. Undoing the gesture that is the last pending
 * step drops that step, so undoing back to the head leaves a clean draft;
 * undoing one that is already saved applies its inverse as a new step.
 */

import type {
  Automation,
  AutomationDetail,
  AutomationLayout,
  AutomationOp,
  Issue,
  NodePosition
} from '@shared/types/automation.types'
import { TRIGGER } from '../ports'
import { applyOps, type DraftDoc, type OpRejection } from './apply-op'
import { inverseOps } from './inverse'

type LayoutKey = keyof AutomationLayout

/** Positions to set; `null` removes the stored position. */
export type LayoutPatch = Partial<Record<LayoutKey, NodePosition | null>>

/** One direction of a gesture: ops for the revision, positions for `set_layout`. */
export type Step = { ops: AutomationOp[]; layout: LayoutPatch }

export type Gesture = { forward: Step; backward: Step }

/** A Save met a newer head; the draft was replayed on it. */
export type Conflict = { by: string | null; dropped: AutomationOp[] }

export type Draft = {
  /** The host head this draft is based on. */
  base: Automation
  baseIssues: Issue[]
  /** Applied since `base`, in order; empty means nothing to save. */
  pending: Step[]
  /** `base` with every pending step applied. */
  doc: DraftDoc
  layout: AutomationLayout
  /** From the latest dry run of `pending`, or `baseIssues` when clean. */
  issues: Issue[]
  undo: Gesture[]
  redo: Gesture[]
  conflict: Conflict | null
}

type Head = Pick<AutomationDetail, 'automation' | 'issues'>

export type DraftAction =
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'undo' }
  | { type: 'redo' }
  /** A dry run of `pending`; ignored once the draft has moved on. */
  | { type: 'previewed'; pending: Step[]; issues: Issue[] }
  | { type: 'saved'; automation: Automation; issues: Issue[] }
  /** Positions the host refused to store: pending again, outside the history. */
  | { type: 'requeue'; layout: LayoutPatch }
  /** The host head changed under the draft (`automation_changed`). */
  | { type: 'head'; head: Head }
  | { type: 'rebased'; head: Head; by: string | null }
  | { type: 'discard' }
  | { type: 'dismiss_conflict' }

function docOf(automation: Automation): DraftDoc {
  const { name, trigger, graph, isolation } = automation
  return { name, trigger, graph, isolation }
}

export function openDraft({ automation, issues }: Head): Draft {
  return {
    base: automation,
    baseIssues: issues,
    pending: [],
    doc: docOf(automation),
    layout: automation.layout,
    issues,
    undo: [],
    redo: [],
    conflict: null
  }
}

export function pendingOps(draft: Draft): AutomationOp[] {
  return draft.pending.flatMap((step) => step.ops)
}

function patchLayout(layout: AutomationLayout, patch: LayoutPatch): AutomationLayout {
  const next = { ...layout }
  for (const [key, position] of Object.entries(patch) as [LayoutKey, NodePosition | null][]) {
    if (position === null) delete next[key]
    else next[key] = position
  }
  return next
}

type State = Pick<Draft, 'doc' | 'layout'>

function applyStep(state: State, step: Step): State | null {
  const doc =
    step.ops.length === 0 ? { ok: true as const, doc: state.doc } : applyOps(state.doc, step.ops)
  if (!doc.ok) return null
  return { doc: doc.doc, layout: patchLayout(state.layout, step.layout) }
}

/** `base` with `steps` applied; null when one no longer applies. */
function replay(base: Automation, steps: Step[]): State | null {
  let state: State | null = { doc: docOf(base), layout: base.layout }
  for (const step of steps) {
    state = applyStep(state, step)
    if (state === null) return null
  }
  return state
}

/**
 * The gesture that applies `ops` and `layout` to the draft, with the ops and
 * positions that undo it, or why the host would refuse the ops.
 */
export function planGesture(
  draft: Draft,
  ops: AutomationOp[],
  layout: LayoutPatch = {}
): Gesture | OpRejection {
  if (ops.length > 0) {
    const result = applyOps(draft.doc, ops)
    if (!result.ok) return result.rejection
  }
  const backwardOps = inverseOps(draft.doc, ops) ?? []
  const backwardLayout: LayoutPatch = {}
  for (const key of Object.keys(layout) as LayoutKey[]) {
    backwardLayout[key] = draft.layout[key] ?? null
  }
  return { forward: { ops, layout }, backward: { ops: backwardOps, layout: backwardLayout } }
}

/** Steps `step` onto the draft: drops it when it undoes the last pending step, else appends it. */
function walk(draft: Draft, step: Step, undoes: Step): Draft | null {
  if (draft.pending.at(-1) === undoes) {
    const pending = draft.pending.slice(0, -1)
    const state = replay(draft.base, pending)
    if (state === null) return null
    return {
      ...draft,
      ...state,
      pending,
      issues: pending.length === 0 ? draft.baseIssues : draft.issues
    }
  }
  const state = applyStep(draft, step)
  if (state === null) return null
  return { ...draft, ...state, pending: [...draft.pending, step] }
}

function nodeExists(doc: DraftDoc, id: string): boolean {
  return id === TRIGGER || doc.graph.nodes.some((node) => node.id === id)
}

/**
 * `steps` replayed op by op on `head`. An op is dropped when the host would
 * refuse it there, or when it connects a step that is gone.
 */
function rebase(head: Automation, steps: Step[]): { steps: Step[]; dropped: AutomationOp[] } {
  let doc = docOf(head)
  const dropped: AutomationOp[] = []
  const kept: Step[] = []
  for (const step of steps) {
    const ops: AutomationOp[] = []
    for (const op of step.ops) {
      const result = applyOps(doc, [op])
      const orphan =
        op.op === 'connect' && (!nodeExists(doc, op.edge.from) || !nodeExists(doc, op.edge.to))
      if (!result.ok || orphan) {
        dropped.push(op)
        continue
      }
      ops.push(op)
      doc = result.doc
    }
    const layout = Object.fromEntries(
      Object.entries(step.layout).filter(([key]) => nodeExists(doc, key))
    ) as LayoutPatch
    if (ops.length > 0 || Object.keys(layout).length > 0) kept.push({ ops, layout })
  }
  return { steps: kept, dropped }
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'gesture': {
      const state = applyStep(draft, action.gesture.forward)
      if (state === null) return draft
      return {
        ...draft,
        ...state,
        pending: [...draft.pending, action.gesture.forward],
        undo: [...draft.undo, action.gesture],
        redo: []
      }
    }
    case 'undo': {
      const gesture = draft.undo.at(-1)
      if (!gesture) return draft
      const next = walk(draft, gesture.backward, gesture.forward)
      if (next === null) return draft
      return { ...next, undo: draft.undo.slice(0, -1), redo: [...draft.redo, gesture] }
    }
    case 'redo': {
      const gesture = draft.redo.at(-1)
      if (!gesture) return draft
      const next = walk(draft, gesture.forward, gesture.backward)
      if (next === null) return draft
      return { ...next, redo: draft.redo.slice(0, -1), undo: [...draft.undo, gesture] }
    }
    case 'previewed':
      return action.pending === draft.pending && draft.pending.length > 0
        ? { ...draft, issues: action.issues }
        : draft
    case 'saved': {
      const opened = openDraft({ automation: action.automation, issues: action.issues })
      // History stays valid only on our own revision: one bump for the ops, none for positions.
      const own = draft.base.revision + (pendingOps(draft).length > 0 ? 1 : 0)
      return action.automation.revision === own
        ? { ...opened, undo: draft.undo, redo: draft.redo }
        : opened
    }
    case 'requeue': {
      const step: Step = { ops: [], layout: action.layout }
      return {
        ...draft,
        layout: patchLayout(draft.layout, action.layout),
        pending: [...draft.pending, step]
      }
    }
    case 'head': {
      const { automation } = action.head
      // A dirty draft keeps its base; Save then meets the new head and rebases.
      if (draft.pending.length > 0 || automation.revision < draft.base.revision) return draft
      const opened = openDraft(action.head)
      // Another author's revision makes the saved half of the history stale.
      return automation.revision === draft.base.revision
        ? { ...opened, undo: draft.undo, redo: draft.redo }
        : opened
    }
    case 'rebased': {
      if (draft.pending.length === 0 || action.head.automation.revision <= draft.base.revision) {
        return draft
      }
      const { steps, dropped } = rebase(action.head.automation, draft.pending)
      let rebased = openDraft(action.head)
      for (const step of steps) {
        const gesture = planGesture(rebased, step.ops, step.layout)
        if (!('forward' in gesture)) continue
        rebased = draftReducer(rebased, { type: 'gesture', gesture })
      }
      return { ...rebased, conflict: { by: action.by, dropped } }
    }
    case 'discard':
      return openDraft({ automation: draft.base, issues: draft.baseIssues })
    case 'dismiss_conflict':
      return { ...draft, conflict: null }
  }
}
