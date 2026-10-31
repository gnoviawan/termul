import { describe, expect, it } from 'vitest'
import {
  type CompactSignals,
  type CompactState,
  compactReducer,
  INITIAL_COMPACT_STATE
} from './compact-request'

const IDLE: CompactSignals = {
  connected: true,
  activeTurn: false,
  compaction: null,
  usageUpdatedAt: 1
}

function pending(): CompactState {
  return compactReducer(INITIAL_COMPACT_STATE, { type: 'request' })
}

function signal(state: CompactState, overrides: Partial<CompactSignals>): CompactState {
  return compactReducer(state, { type: 'signals', signals: { ...IDLE, ...overrides } })
}

describe('compactReducer', () => {
  it('stays pending until the agent shows activity, then finishes when it ends', () => {
    let state = pending()
    state = signal(state, {})
    expect(state.phase).toBe('pending')
    state = signal(state, { compaction: 'started' })
    expect(state.phase).toBe('pending')
    state = signal(state, { compaction: null })
    expect(state.phase).toBe('idle')
  })

  it('treats a turn that starts and ends as done (agents without compaction markers)', () => {
    let state = signal(pending(), { activeTurn: true })
    state = signal(state, { activeTurn: false })
    expect(state).toEqual(INITIAL_COMPACT_STATE)
  })

  it('fails on a failed compaction marker', () => {
    expect(signal(pending(), { compaction: 'failed' }).phase).toBe('failed')
  })

  it('resets at once when the session disconnects', () => {
    expect(signal(pending(), { connected: false })).toEqual(INITIAL_COMPACT_STATE)
  })

  it('fails on timeout and clears the error on the next usage report', () => {
    let state = compactReducer(pending(), { type: 'timeout', usageUpdatedAt: 1 })
    expect(state.phase).toBe('failed')
    state = signal(state, { usageUpdatedAt: 1 })
    expect(state.phase).toBe('failed')
    state = signal(state, { usageUpdatedAt: 2 })
    expect(state).toEqual(INITIAL_COMPACT_STATE)
  })

  it('ignores a timeout that arrives after the request finished', () => {
    expect(compactReducer(INITIAL_COMPACT_STATE, { type: 'timeout', usageUpdatedAt: 1 })).toEqual(
      INITIAL_COMPACT_STATE
    )
  })
})
