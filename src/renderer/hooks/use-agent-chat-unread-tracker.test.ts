import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { useAgentChatUnreadTracker } from './use-agent-chat-unread-tracker'

/**
 * Drives the tracker against the real acp, lifetime and unread stores. The
 * matrix rows are named in the test titles (background turn, active turn,
 * unread viewed, project switch, closing wins).
 */

function seedChat(sessionId: string, busy = false): void {
  seedOptionsSession(sessionId, 'agent-1', {
    title: sessionId,
    activeTurn: busy,
    openTurnId: busy ? 'turn-1' : null
  })
}

function setTurn(sessionId: string, busy: boolean): void {
  act(() => {
    const state = useAcpStore.getState()
    const session = state.sessions[sessionId]
    if (!session) throw new Error(`session ${sessionId} not seeded`)
    useAcpStore.setState({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...session, activeTurn: busy, openTurnId: busy ? 'turn-1' : null }
      }
    })
  })
}

function unreadIds(): string[] {
  return Object.keys(useAgentChatUnreadStore.getState().unread).sort()
}

function renderTracker(activeSessionIds: readonly string[]) {
  return renderHook(({ active }) => useAgentChatUnreadTracker(active), {
    initialProps: { active: activeSessionIds }
  })
}

beforeEach(() => {
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatUnreadStore.setState({
    unread: {},
    unreadSince: {},
    seenTurnEndSeq: {},
    sharedReadSeq: {}
  })
})

function turnEnd(sessionId: string, seq: number): void {
  act(() => useAgentChatUnreadStore.getState().noteTurnEnd(sessionId, seq))
}

function readElsewhere(sessionId: string, seq: number): void {
  act(() => useAgentChatUnreadStore.getState().setReadMark(sessionId, seq))
}

describe('useAgentChatUnreadTracker', () => {
  it('marks a background chat unread when its turn finishes (busy to idle)', () => {
    seedChat('a')
    seedChat('b')
    renderTracker(['a'])

    setTurn('b', true)
    expect(unreadIds()).toEqual([])

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('banks a dot when the tracker mounted mid-turn and the turn then finishes', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker(['a'])
    expect(unreadIds()).toEqual([])

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('also counts an openTurnId-only busy signal', () => {
    seedChat('a')
    seedOptionsSession('b', 'agent-1', { title: 'b', activeTurn: false, openTurnId: 't1' })
    renderTracker(['a'])

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('sets no unread for the active chat when its turn finishes', () => {
    seedChat('a')
    seedChat('b')
    renderTracker(['a'])

    setTurn('a', true)
    setTurn('a', false)

    expect(unreadIds()).toEqual([])
  })

  it('banks a dot for a chat that finishes while a non-chat tab (no active chat) is showing', () => {
    seedChat('a')
    renderTracker([])

    setTurn('a', true)
    setTurn('a', false)
    expect(unreadIds()).toEqual(['a'])
  })

  it('clears an unread chat when it becomes the active chat, and keeps it cleared', () => {
    seedChat('a')
    seedChat('b')
    const { rerender } = renderTracker(['a'])
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    rerender({ active: ['b'] })
    expect(unreadIds()).toEqual([])

    // Still active: a later turn finishing on it banks nothing.
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual([])

    // Leaving it does not bring the dot back.
    rerender({ active: ['a'] })
    expect(unreadIds()).toEqual([])
  })

  it('keeps an unread chat across a project switch and back', () => {
    seedChat('a')
    seedChat('b')
    const { rerender } = renderTracker(['a'])
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    // Switching project swaps the active tab (here: a chat of another project,
    // then no chat) without dropping b's live session.
    act(() => seedChat('other-project-chat'))
    rerender({ active: ['other-project-chat'] })
    expect(unreadIds()).toEqual(['b'])
    rerender({ active: [] })
    expect(unreadIds()).toEqual(['b'])

    rerender({ active: ['a'] })
    expect(unreadIds()).toEqual(['b'])
  })

  it('banks nothing when the turn ends because the session closed', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker(['a'])

    act(() => {
      const state = useAcpStore.getState()
      useAcpStore.setState({
        sessions: { ...state.sessions, b: { ...state.sessions.b, status: 'closed' } }
      })
    })

    expect(unreadIds()).toEqual([])
  })

  it('ignores an ephemeral (warm-pool) session', () => {
    seedChat('a')
    seedChat('warm', true)
    _addEphemeralSessionIdForTesting('warm')
    renderTracker(['a'])

    setTurn('warm', false)

    expect(unreadIds()).toEqual([])
  })

  it('keeps an unread chat when its session closes, errors, or vanishes', () => {
    seedChat('a')
    seedChat('b')
    seedChat('c')
    seedChat('d')
    renderTracker(['a'])
    for (const id of ['b', 'c', 'd']) {
      setTurn(id, true)
      setTurn(id, false)
    }
    expect(unreadIds()).toEqual(['b', 'c', 'd'])

    act(() => {
      const state = useAcpStore.getState()
      const { c: _removed, ...rest } = state.sessions
      useAcpStore.setState({
        sessions: {
          ...rest,
          b: { ...state.sessions.b, status: 'closed' },
          d: { ...state.sessions.d, status: 'error' }
        }
      })
    })

    expect(unreadIds()).toEqual(['b', 'c', 'd'])
  })

  it('sets Done for a cancelled turn (busy to idle) like a normal finish', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker(['a'])

    // Cancel clears the turn through _onPromptComplete: activeTurn and
    // openTurnId both drop, which is the same busy to idle edge.
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('sets nothing for chats that are the active tabs of different panes', () => {
    seedChat('a')
    seedChat('b')
    seedChat('c')
    renderTracker(['a', 'b'])

    for (const id of ['a', 'b', 'c']) {
      setTurn(id, true)
      setTurn(id, false)
    }

    expect(unreadIds()).toEqual(['c'])
  })

  it('clears every active chat when several become active at once', () => {
    seedChat('a')
    seedChat('b')
    seedChat('c')
    const { rerender } = renderTracker([])
    for (const id of ['a', 'b', 'c']) {
      setTurn(id, true)
      setTurn(id, false)
    }
    expect(unreadIds()).toEqual(['a', 'b', 'c'])

    rerender({ active: ['a', 'c'] })
    expect(unreadIds()).toEqual(['b'])
  })

  it('tolerates a partial acp-store shape (no sessions record)', () => {
    act(() => {
      useAcpStore.setState({ sessions: undefined } as never)
    })

    expect(() => renderTracker(['a'])).not.toThrow()
    expect(unreadIds()).toEqual([])
  })

  it('clears a dot when another surface reads the turn end that raised it', () => {
    seedChat('a')
    seedChat('b')
    renderTracker(['a'])
    setTurn('b', true)
    turnEnd('b', 12)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    readElsewhere('b', 12)

    expect(unreadIds()).toEqual([])
  })

  it('keeps a dot whose turn ended with no turn end seen here, when an older read is swept again', () => {
    seedChat('a')
    seedChat('b')
    turnEnd('b', 10)
    readElsewhere('b', 10)
    renderTracker(['a'])
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    turnEnd('a', 11)
    act(() => useAgentChatUnreadStore.getState().setReadMarks({ b: 10 }))

    expect(unreadIds()).toEqual(['b'])
  })

  it('keeps a dot when a second background turn ends with no turn end and the first is read elsewhere', () => {
    seedChat('a')
    seedChat('b')
    renderTracker(['a'])
    setTurn('b', true)
    turnEnd('b', 10)
    setTurn('b', false)
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    readElsewhere('b', 10)

    expect(unreadIds()).toEqual(['b'])
  })
})
