import fixture from '@shared/types/__fixtures__/automation-ops.json'
import type { AutomationOp, Edge } from '@shared/types/automation.types'
import { describe, expect, it } from 'vitest'
import { applyOps, type ConnectRefusal, type DraftDoc, refuseConnect } from './apply-op'
import { inverseOps } from './inverse'

// The same file drives `graph_fixture_tests.rs` against `graph::apply_ops`.
type ApplyCase = {
  name: string
  ops: AutomationOp[]
  expect?: DraftDoc
  reject?: { code: string; index?: number }
}
type ConnectCase = {
  name: string
  ops?: AutomationOp[]
  edge: Edge
  refuse: ConnectRefusal | null
}

const start = fixture.start as unknown as DraftDoc
const applyCases = fixture.apply as unknown as ApplyCase[]
const connectCases = fixture.connect as unknown as ConnectCase[]

describe('applyOps mirrors graph::apply_ops', () => {
  it.each(applyCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = applyOps(start, c.ops)
    if (c.expect) {
      expect(result).toEqual({ ok: true, doc: c.expect })
    } else {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.rejection).toMatchObject(c.reject ?? {})
    }
  })

  it('covers every op kind and every rejection', () => {
    const kinds = new Set(applyCases.flatMap((c) => c.ops.map((op) => op.op)))
    expect([...kinds].sort()).toEqual(
      [
        'add_node',
        'connect',
        'disconnect',
        'remove_node',
        'rename',
        'set_isolation',
        'set_trigger',
        'update_node'
      ].sort()
    )
    const codes = new Set(applyCases.flatMap((c) => (c.reject ? [c.reject.code] : [])))
    expect([...codes].sort()).toEqual(
      [
        'edge_exists',
        'edge_not_found',
        'empty_batch',
        'empty_name',
        'invalid_node_id',
        'node_exists',
        'node_not_found'
      ].sort()
    )
  })

  it.each(
    applyCases.filter((c) => c.expect).map((c) => [c.name, c] as const)
  )('the inverse of "%s" restores the start', (_name, c) => {
    const after = applyOps(start, c.ops)
    if (!after.ok) throw new Error('expected the batch to apply')
    const undo = inverseOps(start, c.ops)
    if (undo === null) throw new Error('expected an inverse')
    const back = applyOps(after.doc, undo)
    if (!back.ok) throw new Error(`inverse refused: ${JSON.stringify(back.rejection)}`)
    // Undo re-adds a removed node and its edges at the end, so compare as sets.
    const sorted = (doc: DraftDoc) => ({
      ...doc,
      graph: {
        nodes: [...doc.graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...doc.graph.edges].map((edge) => JSON.stringify(edge)).sort()
      }
    })
    expect(sorted(back.doc)).toEqual(sorted(start))
  })
})

describe('refuseConnect matches the host rules for a new edge', () => {
  it.each(connectCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const before = c.ops ? applyOps(start, c.ops) : { ok: true as const, doc: start }
    if (!before.ok) throw new Error('fixture setup ops must apply')
    expect(refuseConnect(before.doc.graph, c.edge)).toBe(c.refuse)
  })
})
