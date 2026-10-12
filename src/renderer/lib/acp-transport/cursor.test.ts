import type { WsEvent } from '@shared/types/web-protocol.types'
import { describe, expect, it } from 'vitest'
import { HELD_ITEM_LIMIT, judgeEvent, SyncGate } from './cursor'

const evt = (seq: number): WsEvent => ({ sid: 's', seq, type: 'tool_call', payload: {} })

describe('judgeEvent', () => {
  it('drops a seq already applied', () => {
    expect(judgeEvent(5, 5, 5)).toBe('duplicate')
    expect(judgeEvent(5, 9, 3)).toBe('duplicate')
  })

  it('applies replay up to the head across holes', () => {
    expect(judgeEvent(2, 9, 5)).toBe('apply')
    expect(judgeEvent(0, 9, 9)).toBe('apply')
  })

  it('requires the next seq above the head', () => {
    expect(judgeEvent(9, 9, 10)).toBe('apply')
    expect(judgeEvent(9, 9, 11)).toBe('gap')
  })

  it('measures contiguity from the head when replay ended below it', () => {
    // Replay applied up to 6 but the head is 9 (7..9 were non-durable).
    expect(judgeEvent(6, 9, 10)).toBe('apply')
    expect(judgeEvent(6, 9, 7)).toBe('apply')
  })
})

describe('SyncGate', () => {
  it('holds only while syncing and releases in arrival order at the outermost end', () => {
    const gate = new SyncGate()
    expect(gate.hold('s', { kind: 'event', evt: evt(1) })).toBe(false)
    gate.begin('s', 0)
    gate.begin('s', 0)
    expect(gate.hold('s', { kind: 'event', evt: evt(1) })).toBe(true)
    expect(gate.hold('s', { kind: 'gap' })).toBe(true)
    expect(gate.end('s')).toBeNull()
    expect(gate.isSyncing('s')).toBe(true)
    const result = gate.end('s')
    expect(result?.held.map((item) => item.kind)).toEqual(['event', 'gap'])
    expect(result?.lost).toBe(false)
    expect(gate.isSyncing('s')).toBe(false)
  })

  it('marks the buffer lost instead of growing past its limit', () => {
    const gate = new SyncGate()
    gate.begin('s', 0)
    for (let i = 0; i < HELD_ITEM_LIMIT + 5; i += 1) {
      gate.hold('s', { kind: 'event', evt: evt(i + 1) })
    }
    const result = gate.end('s')
    expect(result?.held).toHaveLength(HELD_ITEM_LIMIT)
    expect(result?.lost).toBe(true)
  })
})
