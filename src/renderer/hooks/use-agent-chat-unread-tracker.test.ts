import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
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

function setClosing(sessionId: string, closing: boolean): void {
  act(() => {
    useAgentChatLifetimeStore.setState({
      closingSessionIds: closing ? { [sessionId]: true } : {}
    })
  })
}

function unreadIds(): string[] {
  return Object.keys(useAgentChatUnreadStore.getState().unread).sort()
}

function renderTracker(activeSessionId: string | null) {
  return renderHook(({ active }) => useAgentChatUnreadTracker(active), {
    initialProps: { active: activeSessionId }
  })
}

beforeEach(() => {
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatLifetimeStore.setState({
    retainedByProject: {},
    activeSessionByProject: {},
    focusSessionByProject: {},
    closingSessionIds: {}
  })
  useAgentChatUnreadStore.setState({ unread: {} })
})

describe('useAgentChatUnreadTracker', () => {
  it('marks a background chat unread when its turn finishes (busy to idle)', () => {
    seedChat('a')
    seedChat('b')
    renderTracker('a')

    setTurn('b', true)
    expect(unreadIds()).toEqual([])

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('banks a dot when the tracker mounted mid-turn and the turn then finishes', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker('a')
    expect(unreadIds()).toEqual([])

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('also counts an openTurnId-only busy signal', () => {
    seedChat('a')
    seedOptionsSession('b', 'agent-1', { title: 'b', activeTurn: false, openTurnId: 't1' })
    renderTracker('a')

    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])
  })

  it('sets no unread for the active chat when its turn finishes', () => {
    seedChat('a')
    seedChat('b')
    renderTracker('a')

    setTurn('a', true)
    setTurn('a', false)

    expect(unreadIds()).toEqual([])
  })

  it('banks a dot for a chat that finishes while a non-chat tab (no active chat) is showing', () => {
    seedChat('a')
    renderTracker(null)

    setTurn('a', true)
    setTurn('a', false)
    expect(unreadIds()).toEqual(['a'])
  })

  it('clears an unread chat when it becomes the active chat, and keeps it cleared', () => {
    seedChat('a')
    seedChat('b')
    const { rerender } = renderTracker('a')
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    rerender({ active: 'b' })
    expect(unreadIds()).toEqual([])

    // Still active: a later turn finishing on it banks nothing.
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual([])

    // Leaving it does not bring the dot back.
    rerender({ active: 'a' })
    expect(unreadIds()).toEqual([])
  })

  it('keeps an unread chat across a project switch and back', () => {
    seedChat('a')
    seedChat('b')
    const { rerender } = renderTracker('a')
    setTurn('b', true)
    setTurn('b', false)
    expect(unreadIds()).toEqual(['b'])

    // Switching project swaps the active tab (here: a chat of another project,
    // then no chat) without dropping b's live session.
    act(() => seedChat('other-project-chat'))
    rerender({ active: 'other-project-chat' })
    expect(unreadIds()).toEqual(['b'])
    rerender({ active: null })
    expect(unreadIds()).toEqual(['b'])

    rerender({ active: 'a' })
    expect(unreadIds()).toEqual(['b'])
  })

  it('lets closing win: a turn that ends while the chat is closing banks nothing', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker('a')
    setClosing('b', true)

    setTurn('b', false)
    expect(unreadIds()).toEqual([])

    // Not even after the closing flag clears.
    setClosing('b', false)
    expect(unreadIds()).toEqual([])
  })

  it('banks nothing when the turn ends because the session closed', () => {
    seedChat('a')
    seedChat('b', true)
    renderTracker('a')

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
    renderTracker('a')

    setTurn('warm', false)

    expect(unreadIds()).toEqual([])
  })

  it('clears an unread chat that is no longer live or no longer present', () => {
    seedChat('a')
    seedChat('b')
    seedChat('c')
    renderTracker('a')
    for (const id of ['b', 'c']) {
      setTurn(id, true)
      setTurn(id, false)
    }
    expect(unreadIds()).toEqual(['b', 'c'])

    act(() => {
      const state = useAcpStore.getState()
      const { c: _removed, ...rest } = state.sessions
      useAcpStore.setState({
        sessions: { ...rest, b: { ...state.sessions.b, status: 'closed' } }
      })
    })

    expect(unreadIds()).toEqual([])
  })

  it('tolerates a partial acp-store shape (no sessions record)', () => {
    act(() => {
      useAcpStore.setState({ sessions: undefined } as never)
    })

    expect(() => renderTracker('a')).not.toThrow()
    expect(unreadIds()).toEqual([])
  })
})
