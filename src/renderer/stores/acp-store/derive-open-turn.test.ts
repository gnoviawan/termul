import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/lib/acp-api'
import { deriveOpenTurn } from './helpers'

function message(role: ChatMessage['role'], id: string, seq: number): ChatMessage {
  return { id, role, blocks: [], streaming: false, timestamp: seq, seq } as ChatMessage
}

// A turn that failed: the agent never replied, so the transcript ends on the
// user's own bubble.
const FAILED_TURN: ChatMessage[] = [message('user', 'turn:t1', 1)]

describe('deriveOpenTurn (issue #1192)', () => {
  it('reads a trailing user bubble as an open turn when the host says nothing', () => {
    // Older hosts, and an open prompt without a turn id, leave `turnActive` out.
    expect(deriveOpenTurn(FAILED_TURN, undefined)).toBe('turn:t1')
    expect(deriveOpenTurn([message('user', 'u1', 4)], undefined)).toBe('turn:seq-4')
  })

  it('treats an explicit turnActive false as a finished turn, whatever the transcript ends on', () => {
    expect(deriveOpenTurn(FAILED_TURN, false)).toBeNull()
    expect(deriveOpenTurn([message('user', 'u1', 4)], false)).toBeNull()
  })

  it('still reports the open turn when the host says one runs', () => {
    expect(deriveOpenTurn(FAILED_TURN, true)).toBe('turn:t1')
  })

  it('reports no open turn once the agent has replied after the last user message', () => {
    const answered = [message('user', 'turn:t1', 1), message('agent', 'a1', 2)]
    expect(deriveOpenTurn(answered, undefined)).toBeNull()
  })
})
