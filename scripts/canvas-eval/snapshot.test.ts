import { describe, expect, test } from 'vitest'
import { lastSnapshotFailed, snapshotFailure } from './snapshot.ts'
import type { Rpc } from './upstream.ts'

const saved: Rpc = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }

function tree(document: unknown): Rpc {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: { content: [{ type: 'text', text: JSON.stringify(document) }] }
  }
}

describe('snapshotFailure', () => {
  test('a whole tree is a snapshot', () => {
    expect(snapshotFailure(saved, tree({ pages: [{ children: [] }] }))).toBeUndefined()
  })

  test('a truncated tree fails and says how it was cut', () => {
    const failure = snapshotFailure(
      saved,
      tree({ pages: [], truncated: { requestedDepth: 64, depth: 3 } })
    )
    expect(failure).toContain('truncated')
    expect(failure).toContain('"depth":3')
  })

  test('an error from either call fails', () => {
    const refused: Rpc = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'no document' } }
    expect(snapshotFailure(refused, tree({ pages: [] }))).toContain('no document')
    const errored: Rpc = {
      jsonrpc: '2.0',
      id: 2,
      result: { isError: true, content: [{ type: 'text', text: 'boom' }] }
    }
    expect(snapshotFailure(saved, errored)).toContain('boom')
  })

  test('a reply with no JSON text fails', () => {
    expect(snapshotFailure(saved, { jsonrpc: '2.0', id: 2, result: { content: [] } })).toBeDefined()
    const garbled: Rpc = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'not json' }] }
    }
    expect(snapshotFailure(saved, garbled)).toBeDefined()
  })
})

describe('lastSnapshotFailed', () => {
  const changed = { isError: false, attempted: true }
  const failed = { isError: false, attempted: true, snapshotError: 'truncated' }
  const read = { isError: false }

  test('a failed snapshot leaves the document stale until one succeeds', () => {
    expect(lastSnapshotFailed([changed, failed, read])).toBe(true)
    expect(lastSnapshotFailed([failed, changed, read])).toBe(false)
  })

  test('a run with no snapshot attempt has nothing stale', () => {
    expect(lastSnapshotFailed([read])).toBe(false)
    expect(lastSnapshotFailed([])).toBe(false)
  })
})
