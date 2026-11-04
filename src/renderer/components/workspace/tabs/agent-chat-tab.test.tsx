import type { ChatActivityRecord } from '@shared/types/web-protocol.types'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { chatActivityRecord, resetChatActivity } from '@/lib/test-utils/chat-activity'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useChatActivityStore } from '@/stores/chat-activity-store'
import { agentChatTabId } from '@/stores/workspace-store'
import { AgentChatTabInline } from './agent-chat-tab'

/**
 * Spec: agent-chat-tab-activity-indicator. The lamp slot is a turn-lifecycle
 * cue from the host's `chat_activity` record: a Working spinner while the host
 * has a turn open, then an unread dot for a turn end nobody has read, hidden
 * while this renderer shows the chat. The harness drives host deltas through
 * the real `useChatActivityStore`, the way `chat-activity-sync` applies them,
 * and marks the active chip's chat as shown the way the shell mount does.
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

/** Render a chip; an active chip's chat is one this renderer shows. */
function renderChip(isActive: boolean, sessionId = 's1') {
  useChatActivityStore.getState().setViewing(isActive ? [sessionId] : [])
  return render(chipElement(isActive, sessionId))
}

function rerenderChip(
  rerender: (ui: React.ReactElement) => void,
  isActive: boolean,
  sessionId = 's1'
) {
  act(() => useChatActivityStore.getState().setViewing(isActive ? [sessionId] : []))
  rerender(chipElement(isActive, sessionId))
}

/** The chip root is the first aria-labelled element (the close button comes later in DOM order). */
function chipRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[aria-label]')
  if (!(root instanceof HTMLElement)) throw new Error('chip root not found')
  return root
}

/** Apply one host `chat_activity` delta. */
function hostSays(sessionId: string, record: Partial<ChatActivityRecord>): void {
  act(() => useChatActivityStore.getState().apply({ sessionId, ...chatActivityRecord(record) }))
}

let turnSeq = 0

/** The host opens a turn, or ends it with a turn end nobody has read yet. */
function setTurn(sessionId: string, busy: boolean): void {
  if (busy) {
    const current = useChatActivityStore.getState().sessions[sessionId]
    hostSays(sessionId, { ...current, busy: true })
    return
  }
  turnSeq += 1
  hostSays(sessionId, { busy: false, unread: true, turnEnd: { seq: turnSeq, logEpoch: 'e1' } })
}

const WORKING = 'Working'
const UNREAD = 'New activity'
const NEEDS_YOU = 'Needs you'

function seedChat(sessionId = 's1', title = 'My Chat'): void {
  seedOptionsSession(sessionId, 'agent-1', { title })
}

beforeEach(() => {
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  resetChatActivity()
})

describe('AgentChatTabInline activity indicator', () => {
  it('spins while the host has a turn open on an inactive tab, with no lamp dot', () => {
    seedChat()
    setTurn('s1', true)

    const { container } = renderChip(false)

    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByTitle('Connected')).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Working')
  })

  it('spins for a chat this renderer never opened', () => {
    setTurn('remote', true)
    renderChip(false, 'remote')
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
  })

  it("ignores stale turn flags on this renderer's own session record", () => {
    seedOptionsSession('s1', 'agent-1', { title: 'My Chat', activeTurn: true, openTurnId: 't1' })
    renderChip(false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
  })

  it('spins on the active tab too', () => {
    seedChat()
    setTurn('s1', true)
    renderChip(true)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
  })

  it('shows the unread dot when the turn finishes while the tab is inactive', () => {
    seedChat()
    const { container } = renderChip(false)

    setTurn('s1', true)
    expect(screen.getByTitle(WORKING)).toBeInTheDocument()
    setTurn('s1', false)
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, New activity')
  })

  it('hides the unread dot while the tab is active and clears it once the host says read', () => {
    seedChat()
    const { container, rerender } = renderChip(false)
    setTurn('s1', true)
    setTurn('s1', false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()

    rerenderChip(rerender, true)
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat')

    hostSays('s1', { unread: false, turnEnd: { seq: turnSeq, logEpoch: 'e1' } })
    rerenderChip(rerender, false)
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it('keeps the unread dot after the session is stopped (closed)', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'My Chat', status: 'closed' })
    setTurn('s1', false)
    const { container } = renderChip(false)
    expect(screen.getByTitle(UNREAD)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, New activity')
  })

  it('mutes a stopped chat title without striking it through', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'My Chat', status: 'closed' })
    renderChip(false)
    const label = screen.getByText('My Chat')
    expect(label).toHaveClass('opacity-60')
    expect(label).not.toHaveClass('line-through')
  })

  it('shows no activity indicators for an ephemeral session', () => {
    seedChat('s-eph', 'Warm chat')
    _addEphemeralSessionIdForTesting('s-eph')
    hostSays('s-eph', { busy: true, needsYou: true, unread: true })

    renderChip(false, 's-eph')

    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
    expect(screen.queryByTitle(NEEDS_YOU)).not.toBeInTheDocument()
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
    hostSays('s1', { needsYou: true })

    const { container } = renderChip(false)

    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')

    hostSays('s1', { needsYou: true, busy: true })
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(screen.queryByTitle(WORKING)).not.toBeInTheDocument()
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')

    hostSays('s1', { needsYou: true, unread: true, turnEnd: { seq: 3, logEpoch: 'e1' } })
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
    expect(screen.queryByTitle(UNREAD)).not.toBeInTheDocument()
  })

  it("reads Needs you from the host, not from this renderer's pending prompts", () => {
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
    expect(screen.queryByTitle(NEEDS_YOU)).not.toBeInTheDocument()

    hostSays('s1', { needsYou: true })
    expect(chipRoot(container)).toHaveAttribute('aria-label', 'My Chat, Needs you')
  })

  it('still flags a disconnected agent this renderer knows about', () => {
    seedChat()
    useAcpStore.setState({ agentStatus: { 'agent-1': 'disconnected' } } as never)
    renderChip(false)
    expect(screen.getByTitle(NEEDS_YOU)).toBeInTheDocument()
  })
})
