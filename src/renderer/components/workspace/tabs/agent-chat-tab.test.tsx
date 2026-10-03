import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { agentChatTabId } from '@/stores/workspace-store'
import { AgentChatTabInline } from './agent-chat-tab'

/**
 * Spec: agent-chat-tab-activity-indicator. The lamp slot is now a
 * turn-lifecycle cue — a Working spinner while `sessionTurnBusy`, then an
 * ephemeral unread dot when a turn finishes while the tab is inactive. The
 * tests seed the real `useAcpStore` / `useAgentChatLifetimeStore` (the
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

function chipElement(isActive: boolean, sessionId = 's1') {
  return (
    <AgentChatTabInline
      tab={{ type: 'agent-chat', id: agentChatTabId(sessionId), sessionId }}
      isActive={isActive}
      {...BASE_PROPS}
    />
  )
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

function setClosing(sessionId: string, closing: boolean): void {
  act(() => {
    useAgentChatLifetimeStore.setState({
      closingSessionIds: closing ? { [sessionId]: true } : {}
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
const CLOSING_TITLE = 'Closing. This chat stops when the turn finishes.'
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
  useAgentChatLifetimeStore.setState({
    retainedByProject: {},
    activeSessionByProject: {},
    focusSessionByProject: {},
    closingSessionIds: {}
  })
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

  it('shows only the Closing spinner while a close is in flight, even mid-turn', () => {
    seedChat('s1', 'My Chat', true)
    useAgentChatLifetimeStore.setState({ closingSessionIds: { s1: true } })

    const { container } = renderChip(false)

    expect(screen.getByTitle(CLOSING_TITLE)).toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Closing')

    // A turn that ends during the close banks no unread dot — not even after
    // the closing flag clears.
    setTurn('s1', false)
    expect(screen.getByTitle(CLOSING_TITLE)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    setClosing('s1', false)
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

  it('resets the unread state when the chip remounts', () => {
    seedChat()
    const first = renderChip(false)

    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    first.unmount()
    renderChip(false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
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
  })

  it('falls back to the plain Agent Chat label when the session is gone', () => {
    const { container } = renderChip(false, 'missing-session')

    expect(screen.getByText('Agent Chat')).toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByTitle(CLOSING_TITLE)).not.toBeInTheDocument()
    expect(screen.queryByTitle(NEEDS_YOU)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'Agent Chat')
  })

  it('keeps the Needs you dot unchanged and coexisting with the activity indicator', () => {
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
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you, Working')

    setTurn('s1', false)
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you, New activity')
  })
})
