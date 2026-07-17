import { describe, expect, it, vi } from 'vitest'
import {
  ACP_TURN_IN_PROGRESS_CODE,
  appendQueuedPrompt,
  buildRecoverPromptToQueuePatch,
  dropPromptQueueForSession,
  isPromptTurnInProgressError,
  sessionTurnBusy,
  waitForTurnClear
} from './prompt-queue-orchestration'

describe('prompt-queue-orchestration', () => {
  it('matches the stable turn-in-progress error code', () => {
    expect(isPromptTurnInProgressError(new Error(`${ACP_TURN_IN_PROGRESS_CODE}: session s1`))).toBe(
      true
    )
    expect(isPromptTurnInProgressError(new Error('network failed'))).toBe(false)
  })

  it('treats openTurnId or activeTurn as busy', () => {
    expect(sessionTurnBusy(undefined)).toBe(false)
    expect(sessionTurnBusy({ openTurnId: null, activeTurn: false })).toBe(false)
    expect(sessionTurnBusy({ openTurnId: 't1', activeTurn: false })).toBe(true)
    expect(sessionTurnBusy({ openTurnId: null, activeTurn: true })).toBe(true)
  })

  it('appends and drops queued prompts', () => {
    const once = appendQueuedPrompt({}, 's1', [{ type: 'text', text: 'a' }], () => 'q1')
    expect(once.s1).toHaveLength(1)
    expect(once.s1[0].id).toBe('q1')

    const twice = appendQueuedPrompt(once, 's1', [{ type: 'text', text: 'b' }], () => 'q2')
    expect(twice.s1).toHaveLength(2)

    expect(dropPromptQueueForSession(twice, 's1')).toEqual({})
    expect(dropPromptQueueForSession(twice, 'missing')).toBe(twice)
  })

  it('builds a recover-to-queue patch that restores the prior turn id', () => {
    const patch = buildRecoverPromptToQueuePatch(
      {
        sessions: {
          s1: { openTurnId: 'attempt', activeTurn: true, lastError: 'x' }
        },
        messages: {
          s1: [{ id: 'msg-1' }, { id: 'msg-keep' }]
        },
        promptQueues: {}
      },
      {
        sessionId: 's1',
        userMessage: { id: 'msg-1' },
        blocks: [{ type: 'text', text: 'retry' }],
        previousOpenTurnId: 'prior',
        attemptedTurnId: 'attempt',
        createQueueId: () => 'q-recover'
      }
    )

    expect(patch.messages.s1.map((m) => m.id)).toEqual(['msg-keep'])
    expect(patch.promptQueues.s1?.[0]?.id).toBe('q-recover')
    expect(patch.sessions.s1).toMatchObject({
      openTurnId: 'prior',
      activeTurn: true,
      lastError: null
    })
  })

  it('waitForTurnClear resolves when openTurnId clears', async () => {
    let openTurnId: string | null = 't1'
    const listeners = new Set<
      (
        state: { sessions: Record<string, { openTurnId: string | null }> },
        prev: { sessions: Record<string, { openTurnId: string | null }> }
      ) => void
    >()

    const get = () => ({ sessions: { s1: { openTurnId } } })
    const subscribe = (
      listener: (
        state: { sessions: Record<string, { openTurnId: string | null }> },
        prev: { sessions: Record<string, { openTurnId: string | null }> }
      ) => void
    ) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    const pending = waitForTurnClear('s1', get, subscribe, 1000)
    const prev = get()
    openTurnId = null
    for (const listener of listeners) listener(get(), prev)

    await expect(pending).resolves.toBeUndefined()
  })

  it('waitForTurnClear rejects on timeout', async () => {
    vi.useFakeTimers()
    try {
      const get = () => ({ sessions: { s1: { openTurnId: 't1' } } })
      const subscribe = () => () => {}
      const pending = waitForTurnClear('s1', get, subscribe, 50)
      const assertion = expect(pending).rejects.toThrow('timed out waiting for turn to clear')
      await vi.advanceTimersByTimeAsync(50)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
