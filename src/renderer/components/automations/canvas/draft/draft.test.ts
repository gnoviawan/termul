import type {
  Automation,
  AutomationNode,
  Edge,
  Issue,
  NodeId
} from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { fixtureAutomation } from '@/lib/test-utils/automation-fixtures'
import {
  type Draft,
  type DraftAction,
  draftReducer,
  type Gesture,
  type LayoutPatch,
  openDraft,
  pendingOps,
  planGesture
} from './draft'

const id = (value: string): NodeId => value as NodeId
const fetch: AutomationNode = {
  id: id('fetch'),
  label: 'Fetch',
  spec: {
    kind: 'http',
    method: 'GET',
    url: 'https://api.example.com/items',
    headers: [],
    body: null,
    allowed_hosts: ['api.example.com']
  }
}
const shape: AutomationNode = {
  id: id('shape'),
  label: 'Shape',
  spec: { kind: 'transform', fields: [] }
}
const stop: AutomationNode = { id: id('stop'), label: 'Stop', spec: { kind: 'fail', message: 'x' } }
const toFetch: Edge = { from: 'trigger', port: 'out', to: id('fetch') }
const fetchToShape: Edge = { from: id('fetch'), port: 'out', to: id('shape') }
const unreachable: Issue = { node_id: id('shape'), code: 'unreachable', message: 'unreachable' }

function head(patch: Partial<Automation> = {}): Automation {
  return {
    ...fixtureAutomation,
    revision: 4,
    approved_revision: 4,
    graph: { nodes: [fetch], edges: [toFetch] },
    layout: { trigger: { x: 0, y: 0 }, fetch: { x: 240, y: 0 } },
    ...patch
  }
}

function gesture(draft: Draft, ops: Parameters<typeof planGesture>[1], layout?: LayoutPatch) {
  const planned = planGesture(draft, ops, layout)
  if (!('forward' in planned)) throw new Error(`refused: ${planned.code}`)
  return planned
}

function run(draft: Draft, ...actions: (DraftAction | ((d: Draft) => DraftAction))[]): Draft {
  return actions.reduce<Draft>(
    (state, action) => draftReducer(state, typeof action === 'function' ? action(state) : action),
    draft
  )
}

const addShape = (d: Draft): DraftAction => ({
  type: 'gesture',
  gesture: gesture(d, [{ op: 'add_node', node: shape }], { shape: { x: 480, y: 0 } })
})
const connectShape = (d: Draft): DraftAction => ({
  type: 'gesture',
  gesture: gesture(d, [{ op: 'connect', edge: fetchToShape }])
})

describe('draftReducer', () => {
  it('applies a gesture locally and queues its ops for Save', () => {
    const draft = run(openDraft({ automation: head(), issues: [] }), addShape, connectShape)

    expect(draft.doc.graph).toEqual({ nodes: [fetch, shape], edges: [toFetch, fetchToShape] })
    expect(draft.layout).toEqual({
      trigger: { x: 0, y: 0 },
      fetch: { x: 240, y: 0 },
      shape: { x: 480, y: 0 }
    })
    expect(pendingOps(draft)).toEqual([
      { op: 'add_node', node: shape },
      { op: 'connect', edge: fetchToShape }
    ])
    expect(draft.pending).toHaveLength(2)
    expect(draft.base.revision).toBe(4)
  })

  it('undoes back to a clean draft, then redoes', () => {
    const opened = openDraft({ automation: head(), issues: [] })
    const twice = run(opened, addShape, connectShape)

    const undone = run(twice, { type: 'undo' }, { type: 'undo' })
    expect(undone.doc.graph).toEqual({ nodes: [fetch], edges: [toFetch] })
    expect(undone.layout).toEqual(opened.layout)
    expect(pendingOps(undone)).toEqual([])

    const redone = run(undone, { type: 'redo' })
    expect(redone.doc.graph).toEqual({ nodes: [fetch, shape], edges: [toFetch] })
    expect(pendingOps(redone)).toEqual([{ op: 'add_node', node: shape }])
    expect(redone.layout.shape).toEqual({ x: 480, y: 0 })
  })

  it('a new gesture clears redo', () => {
    const draft = run(openDraft({ automation: head(), issues: [] }), addShape, { type: 'undo' })
    const moved = run(draft, (d) => ({
      type: 'gesture',
      gesture: gesture(d, [], { fetch: { x: 300, y: 40 } })
    }))
    expect(run(moved, { type: 'redo' })).toBe(moved)
    expect(moved.layout.fetch).toEqual({ x: 300, y: 40 })
    expect(pendingOps(moved)).toEqual([])
    expect(moved.pending).toHaveLength(1)
  })

  it('takes dry-run issues only for the steps they were run on', () => {
    const one = run(openDraft({ automation: head(), issues: [] }), addShape)
    const two = run(one, connectShape)

    const stale = run(two, { type: 'previewed', pending: one.pending, issues: [unreachable] })
    expect(stale.issues).toEqual([])
    const fresh = run(one, { type: 'previewed', pending: one.pending, issues: [unreachable] })
    expect(fresh.issues).toEqual([unreachable])
    // Undo back to the head shows the head's issues again.
    expect(run(fresh, { type: 'undo' }).issues).toEqual([])
  })

  it('after Save the draft is clean on the saved head, and undo inverts the saved edit', () => {
    const edited = run(openDraft({ automation: head(), issues: [] }), addShape, connectShape)
    const saved = head({
      revision: 5,
      graph: edited.doc.graph,
      layout: edited.layout
    })
    const clean = run(edited, { type: 'saved', automation: saved, issues: [] })
    expect(clean.base).toBe(saved)
    expect(clean.pending).toEqual([])

    const undone = run(clean, { type: 'undo' })
    expect(undone.doc.graph).toEqual({ nodes: [fetch, shape], edges: [toFetch] })
    expect(pendingOps(undone)).toEqual([{ op: 'disconnect', edge: fetchToShape }])
    // Redo cancels the inverse instead of stacking a second op.
    expect(pendingOps(run(undone, { type: 'redo' }))).toEqual([])
  })

  it('undoing a saved delete puts the step and its edges back', () => {
    const saved = head({
      graph: { nodes: [fetch, shape], edges: [toFetch, fetchToShape] }
    })
    const removed = run(openDraft({ automation: saved, issues: [] }), (d) => ({
      type: 'gesture',
      gesture: gesture(d, [{ op: 'remove_node', id: id('fetch') }], { fetch: null })
    }))
    expect(removed.doc.graph).toEqual({ nodes: [shape], edges: [] })
    expect(removed.layout.fetch).toBeUndefined()

    const after = run(removed, {
      type: 'saved',
      automation: head({ revision: 5, graph: removed.doc.graph, layout: removed.layout }),
      issues: []
    })
    const undone = run(after, { type: 'undo' })
    expect(undone.doc.graph.nodes).toEqual([shape, fetch])
    expect(undone.doc.graph.edges).toEqual([toFetch, fetchToShape])
    expect(undone.layout.fetch).toEqual({ x: 240, y: 0 })
  })

  it('rebases on a newer head and lists the edits that no longer apply', () => {
    const edited = run(
      openDraft({ automation: head(), issues: [] }),
      addShape,
      connectShape,
      (d) => ({
        type: 'gesture',
        gesture: gesture(d, [{ op: 'update_node', id: id('fetch'), label: 'Fetch items' }])
      })
    )
    // Meanwhile a chat agent removed `fetch` and added `stop`.
    const newer = head({
      revision: 6,
      graph: { nodes: [stop], edges: [{ from: 'trigger', port: 'out', to: id('stop') }] },
      layout: { trigger: { x: 0, y: 0 } }
    })
    const rebased = run(edited, {
      type: 'rebased',
      head: { automation: newer, issues: [] },
      by: 'Claude Code'
    })

    expect(rebased.base).toBe(newer)
    expect(rebased.doc.graph).toEqual({
      nodes: [stop, shape],
      edges: [{ from: 'trigger', port: 'out', to: id('stop') }]
    })
    expect(pendingOps(rebased)).toEqual([{ op: 'add_node', node: shape }])
    expect(rebased.layout).toEqual({ trigger: { x: 0, y: 0 }, shape: { x: 480, y: 0 } })
    expect(rebased.conflict).toEqual({
      by: 'Claude Code',
      dropped: [
        { op: 'connect', edge: fetchToShape },
        { op: 'update_node', id: id('fetch'), label: 'Fetch items' }
      ]
    })
    // The rebased step can still be undone back to the new head.
    expect(run(rebased, { type: 'undo' }).doc.graph).toEqual(newer.graph)
  })

  it('discard drops every pending step and the history', () => {
    const opened = openDraft({ automation: head(), issues: [unreachable] })
    const discarded = run(opened, addShape, connectShape, { type: 'discard' })
    expect(discarded.doc).toEqual(opened.doc)
    expect(discarded.layout).toEqual(opened.layout)
    expect(discarded.issues).toEqual([unreachable])
    expect(pendingOps(discarded)).toEqual([])
    expect(run(discarded, { type: 'undo' })).toBe(discarded)
  })

  it('follows a new head while clean, and keeps its base while dirty', () => {
    const opened = openDraft({ automation: head(), issues: [] })
    const newer = head({ revision: 5, graph: { nodes: [fetch, stop], edges: [toFetch] } })

    expect(
      run(opened, { type: 'head', head: { automation: newer, issues: [] } }).doc.graph
    ).toEqual(newer.graph)
    const dirty = run(opened, addShape)
    expect(run(dirty, { type: 'head', head: { automation: newer, issues: [] } })).toBe(dirty)
  })

  it('refuses a gesture the host would refuse', () => {
    const opened = openDraft({ automation: head(), issues: [] })
    expect(planGesture(opened, [{ op: 'add_node', node: fetch }])).toEqual({
      code: 'node_exists',
      index: 0,
      id: 'fetch'
    })
    const g: Gesture = {
      forward: { ops: [{ op: 'remove_node', id: id('ghost') }], layout: {} },
      backward: { ops: [], layout: {} }
    }
    expect(run(opened, { type: 'gesture', gesture: g })).toBe(opened)
  })

  it('drops the history when the saved revision is not just our own edit', () => {
    const edited = run(openDraft({ automation: head(), issues: [] }), addShape)
    // Another author saved revision 5 first; ours became 6.
    const theirs = run(edited, {
      type: 'saved',
      automation: head({ revision: 6, graph: edited.doc.graph }),
      issues: []
    })
    expect(theirs.undo).toEqual([])
    const ours = run(edited, {
      type: 'saved',
      automation: head({ revision: 5, graph: edited.doc.graph }),
      issues: []
    })
    expect(ours.undo).toHaveLength(1)
  })

  it('keeps positions-only history only when the revision did not move', () => {
    const moved = run(openDraft({ automation: head(), issues: [] }), (d) => ({
      type: 'gesture',
      gesture: gesture(d, [], { fetch: { x: 1, y: 2 } })
    }))
    const layout = { ...moved.layout }
    expect(
      run(moved, { type: 'saved', automation: head({ layout }), issues: [] }).undo
    ).toHaveLength(1)
    expect(
      run(moved, { type: 'saved', automation: head({ revision: 5, layout }), issues: [] }).undo
    ).toEqual([])
  })

  it('ignores a late rebase once the draft is clean', () => {
    const clean = openDraft({ automation: head(), issues: [] })
    const newer = { automation: head({ revision: 9 }), issues: [] }
    expect(run(clean, { type: 'rebased', head: newer, by: null })).toBe(clean)
  })

  it('requeues refused positions as pending without touching undo or redo', () => {
    const draft = run(openDraft({ automation: head(), issues: [] }), addShape, { type: 'undo' })
    const requeued = run(draft, { type: 'requeue', layout: { fetch: { x: 9, y: 9 } } })
    expect(requeued.pending).toHaveLength(1)
    expect(requeued.layout.fetch).toEqual({ x: 9, y: 9 })
    expect(requeued.redo).toBe(draft.redo)
    expect(requeued.undo).toBe(draft.undo)
  })
})
