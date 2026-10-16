import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatUnreadTracker } from '@/hooks/use-agent-chat-unread-tracker'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { agentChatTabId } from '@/stores/workspace-store'
import { AgentChatTabInline } from './agent-chat-tab'

/**
 * Spec: agent-chat-tab-activity-indicator. The lamp slot is now a
 * turn-lifecycle cue — a Working spinner while `sessionTurnBusy`, then an
 * unread dot when a turn finishes while the tab is inactive. The unread flag
 * lives in `useAgentChatUnreadStore`, driven by the shell-level tracker, so the
 * harness below mounts `useAgentChatUnreadTracker` the way `WorkspaceLayout`
 * does (the pane's active chat is the tab's `isActive`). The
 * tests seed the real `useAcpStore` (the
 * WorkspaceTabBar suite mocks `useAcpStore` away, so it cannot cover this)
 * and drive busy + `isActive` transitions through rerender/`setState`.
 */

const BASE_PROPS = {
  isDragging: false,
  isDropTarget: false,
  dropPosition: null,
  bulkMenu: {},
  onSelect: () => {},
  onClose: () => {},
  onDragStart: () => {},
  onDragOver: () => {},
  onDragLeave: () => {},
  onDrop: () => {}
} as const

/** Stand-in for the shell: the one tracker mount plus the chip it serves. */
function ChipWithShellTracker({ isActive, sessionId }: { isActive: boolean; sessionId: string }) {
  useAgentChatUnreadTracker(isActive ? [sessionId] : [])
  return (
    <AgentChatTabInline
      tab={{ type: 'agent-chat', id: agentChatTabId(sessionId), sessionId }}
      isActive={isActive}
      {...BASE_PROPS}
    />
  )
}

function chipElement(isActive: boolean, sessionId = 's1') {
  return <ChipWithShellTracker isActive={isActive} sessionId={sessionId} />
}

function renderChip(isActive: boolean, sessionId = 's1') {
  return render(chipElement(isActive, sessionId))
}

/** The chip root is the first aria-labelled element (the close button comes later in DOM order). */
function chipRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[aria-label]')
  if (!(root instanceof HTMLElement)) throw new Error('chip root not found')
  return root
}

/** Drive a turn-busy transition through the real store. */
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

/** Drive a session status transition (e.g. close mid-turn) through the store. */
function setSessionStatus(sessionId: string, status: 'active' | 'closed' | 'error'): void {
  act(() => {
    const state = useAcpStore.getState()
    const session = state.sessions[sessionId]
    if (!session) throw new Error(`session ${sessionId} not seeded`)
    useAcpStore.setState({
      sessions: { ...state.sessions, [sessionId]: { ...session, status } }
    })
  })
}

const WORKING = 'Working'
const UNREAD = 'New activity'
const NEEDS_YOU = 'Needs you'

function seedChat(sessionId = 's1', title = 'My Chat', busy = false): void {
  seedOptionsSession(sessionId, 'agent-1', {
    title,
    activeTurn: busy,
    openTurnId: busy ? 'turn-1' : null
  })
}

beforeEach(() => {
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatUnreadStore.setState({ unread: {} })
})

describe('AgentChatTabInline activity indicator', () => {
  it('spins while a turn streams on an inactive tab — and no lamp dot exists anywhere', () => {
    seedChat('s1', 'My Chat', true)

    const { container } = renderChip(false)

    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    // The connection lamp is gone from the chip entirely.
    expect(screen.queryByTitle('Connected')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Disconnected')).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Working')
  })

  it('spins while a turn streams on the active tab too', () => {
    seedChat('s1', 'My Chat', true)

    renderChip(true)

    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('shows the unread dot when the turn finishes while the tab is inactive', () => {
    seedChat()
    const { container } = renderChip(false)

    setTurn('s1', true)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()

    setTurn('s1', false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, New activity')
  })

  it('clears the unread dot when the tab becomes active', () => {
    seedChat()
    const { container, rerender } = renderChip(false)

    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    rerender(chipElement(true))
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat')
  })

  it('never shows the unread dot when the turn finishes while the tab is active', () => {
    seedChat()
    renderChip(true)

    setTurn('s1', true)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    setTurn('s1', false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('banks the dot when a turn finishes while inactive even if the chip mounted mid-turn', () => {
    seedChat('s1', 'My Chat', true)
    renderChip(false)

    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    setTurn('s1', false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
  })

  it('spins on an openTurnId-only busy signal (activeTurn false)', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'My Chat', activeTurn: false, openTurnId: 't1' })
    renderChip(false)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it.each([
    'closed',
    'error'
  ] as const)('shows no activity indicator for a %s session with stale turn flags', (status) => {
    seedOptionsSession('s1', 'agent-1', {
      title: 'My Chat',
      status,
      activeTurn: true,
      openTurnId: 't1'
    })
    renderChip(false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('banks no dot when the turn ends because the session closed', () => {
    seedChat('s1', 'My Chat', true)
    renderChip(false)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()

    setSessionStatus('s1', 'closed')
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('re-banks the dot when a second turn finishes while inactive', () => {
    seedChat()
    const { rerender } = renderChip(false)

    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    rerender(chipElement(true))
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()

    rerender(chipElement(false))
    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
  })

  it('banks no dot and composes no aria suffix when the session is deleted mid-turn', () => {
    seedChat('s1', 'My Chat', true)
    const { container } = renderChip(false)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()

    act(() => {
      useAcpStore.setState({ sessions: {} })
    })

    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'Agent Chat')
  })

  it('renders no activity indicator when the chip mounts on an idle session', () => {
    seedChat()
    const { container } = renderChip(false)

    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat')
  })

  it('keeps the unread dot when the chip remounts (the store owns Done)', () => {
    seedChat()
    const first = renderChip(false)

    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    first.unmount()
    renderChip(false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
  })

  it('reads Done from the unread store so a card and the tab agree', () => {
    seedChat()
    const { container } = render(
      <AgentChatTabInline
        tab={{ type: 'agent-chat', id: agentChatTabId('s1'), sessionId: 's1' }}
        isActive={false}
        {...BASE_PROPS}
      />
    )
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()

    act(() => useAgentChatUnreadStore.getState().markUnread('s1'))
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, New activity')

    act(() => useAgentChatUnreadStore.getState().clearUnread('s1'))
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('keeps the unread dot after the session is stopped (closed)', () => {
    seedChat('s1', 'My Chat', true)
    const { container } = renderChip(false)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    setSessionStatus('s1', 'closed')
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, New activity')
    expect(useAgentChatUnreadStore.getState().unread).toEqual({ s1: true })
  })

  it('shows the unread dot on a closed chat with stale turn flags (not Working)', () => {
    seedOptionsSession('s1', 'agent-1', {
      title: 'My Chat',
      status: 'closed',
      activeTurn: true,
      openTurnId: 't1'
    })
    useAgentChatUnreadStore.setState({ unread: { s1: true } })
    renderChip(false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
  })

  it('mutes a stopped chat title without striking it through', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'My Chat', status: 'closed' })
    renderChip(false)
    const label = screen.getByText('My Chat')
    expect(label).toHaveClass('opacity-60')
    expect(label).not.toHaveClass('line-through')
  })

  it('shows no activity indicators for an ephemeral session', () => {
    seedChat('s-eph', 'Warm chat', true)
    _addEphemeralSessionIdForTesting('s-eph')

    renderChip(false, 's-eph')

    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()

    // Even a finished ephemeral turn leaves no dot.
    setTurn('s-eph', false)
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()

    // Nor does an unread flag set by any other path, live or closed.
    act(() => useAgentChatUnreadStore.getState().markUnread('s-eph'))
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    setSessionStatus('s-eph', 'closed')
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('falls back to the plain Agent Chat label when the session is gone', () => {
    const { container } = renderChip(false, 'missing-session')

    expect(screen.getByText('Agent Chat')).toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByTitle(NEEDS_YOU)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'Agent Chat')
  })

  it('announces status changes through a persistent role=status live region', () => {
    seedChat()
    renderChip(false)

    const status = () => screen.getByRole('status', { hidden: true }).textContent
    expect(status()).toBe('')

    setTurn('s1', true)
    expect(status()).toBe('Working')

    setTurn('s1', false)
    expect(status()).toBe('New activity')
  })

  it('pins the Needs you slot over working and unread in the single status slot', () => {
    seedChat()
    useAcpStore.setState({
      pendingPermissions: {
        'req-1': {
          requestId: 'req-1',
          agentId: 'agent-1',
          sessionId: 's1',
          options: [],
          toolCall: null
        }
      }
    })

    const { container } = renderChip(false)

    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')

    setTurn('s1', true)
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')

    setTurn('s1', false)
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')
  })

  it('reads Needs you in the tab chrome for a pending elicitation', () => {
    seedChat()
    useAcpStore.setState({
      pendingElicitations: {
        'elicit-1': {
          requestId: 'elicit-1',
          agentId: 'agent-1',
          sessionId: 's1',
          mode: 'form',
          message: 'Pick a branch',
          fields: []
        }
      }
    })

    const { container } = renderChip(false)

    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')
  })
})
