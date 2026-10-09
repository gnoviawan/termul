import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import {
  AgentChatStatusGlyphs,
  agentChatStatusSlots,
  useAgentChatStatusSignals
} from './agent-chat-status'

const IDLE = {
  closing: false,
  needsAttention: false,
  turnBusy: false,
  liveSession: true,
  unread: false
}

describe('agentChatStatusSlots', () => {
  it('is empty for an idle live chat', () => {
    expect(agentChatStatusSlots(IDLE)).toEqual({
      showWorking: false,
      showUnread: false,
      statuses: [],
      statusText: ''
    })
  })

  it('shows Working while a turn runs', () => {
    const slots = agentChatStatusSlots({ ...IDLE, turnBusy: true })
    expect(slots.showWorking).toBe(true)
    expect(slots.statuses).toEqual(['Working'])
    expect(slots.statusText).toBe('Working')
  })

  it('shows New activity only for an idle live chat that is unread', () => {
    expect(agentChatStatusSlots({ ...IDLE, unread: true }).statuses).toEqual(['New activity'])
    // A turn in flight hides the dot until it finishes.
    expect(agentChatStatusSlots({ ...IDLE, unread: true, turnBusy: true }).showUnread).toBe(false)
    // A dead or ephemeral session never shows it.
    expect(agentChatStatusSlots({ ...IDLE, unread: true, liveSession: false }).showUnread).toBe(
      false
    )
  })

  it('lets Closing win over Working and New activity', () => {
    const slots = agentChatStatusSlots({ ...IDLE, closing: true, turnBusy: true, unread: true })
    expect(slots.showWorking).toBe(false)
    expect(slots.showUnread).toBe(false)
    expect(slots.statuses).toEqual(['Closing'])
  })

  it('shows Needs you alongside Working', () => {
    const slots = agentChatStatusSlots({ ...IDLE, needsAttention: true, turnBusy: true })
    expect(slots.statuses).toEqual(['Needs you', 'Working'])
    expect(slots.statusText).toBe('Needs you, Working')
  })

  it('orders statuses Closing, Needs you, Working, New activity', () => {
    expect(agentChatStatusSlots({ ...IDLE, closing: true, needsAttention: true }).statuses).toEqual(
      ['Closing', 'Needs you']
    )
    expect(agentChatStatusSlots({ ...IDLE, needsAttention: true, unread: true }).statusText).toBe(
      'Needs you, New activity'
    )
  })
})

describe('AgentChatStatusGlyphs', () => {
  const NONE = { closing: false, needsAttention: false, showWorking: false, showUnread: false }

  it('renders nothing when no slot is active', () => {
    const { container } = render(<AgentChatStatusGlyphs {...NONE} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each glyph with its title and sr-only text', () => {
    render(<AgentChatStatusGlyphs closing needsAttention showWorking={false} showUnread={false} />)
    expect(screen.getByTitle('Closing. This chat stops when the turn finishes.')).toBeVisible()
    expect(screen.getByTitle('Needs you')).toHaveClass('text-warning')
    expect(screen.getByText('Closing')).toHaveClass('sr-only')
    expect(screen.getByText('Needs you')).toHaveClass('sr-only')
  })

  it('renders the Working spinner and the New activity primary-fill dot', () => {
    render(<AgentChatStatusGlyphs {...NONE} showWorking />)
    expect(screen.getByTitle('Working')).toHaveClass('size-3.5', 'text-muted-foreground')

    render(<AgentChatStatusGlyphs {...NONE} showUnread />)
    const dot = screen.getByTitle('New activity').querySelector('span[aria-hidden="true"]')
    expect(dot).toHaveClass('bg-primary-fill', 'h-2', 'w-2', 'rounded-full')
  })
})

describe('useAgentChatStatusSignals', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    _resetEphemeralSessionIdsForTesting()
    useAgentChatLifetimeStore.setState({ closingSessionIds: {} })
  })

  it('reads a live idle chat', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.session?.id).toBe('s1')
    expect(result.current).toMatchObject({
      needsAttention: false,
      closing: false,
      liveSession: true,
      turnBusy: false
    })
  })

  it('tracks a turn and a close in flight', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    act(() => {
      const state = useAcpStore.getState()
      useAcpStore.setState({
        sessions: { s1: { ...state.sessions.s1, activeTurn: true, openTurnId: 't1' } }
      })
    })
    expect(result.current.turnBusy).toBe(true)

    act(() => {
      useAgentChatLifetimeStore.setState({ closingSessionIds: { s1: true } })
    })
    expect(result.current.closing).toBe(true)
  })

  it('flags a pending permission or question as Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))
    expect(result.current.needsAttention).toBe(false)

    act(() => {
      useAcpStore.setState({
        pendingPermissions: {
          r1: { requestId: 'r1', agentId: 'agent-1', sessionId: 's1', options: [], toolCall: null }
        }
      })
    })
    expect(result.current.needsAttention).toBe(true)
  })

  it('flags a pending elicitation as Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))
    expect(result.current.needsAttention).toBe(false)

    act(() => {
      useAcpStore.setState({
        pendingElicitations: {
          e1: {
            requestId: 'e1',
            agentId: 'agent-1',
            sessionId: 's1',
            mode: 'form',
            message: 'Pick a branch',
            fields: []
          }
        }
      })
    })
    expect(result.current.needsAttention).toBe(true)

    // Another session's elicitation does not leak in.
    act(() => {
      useAcpStore.setState({
        pendingElicitations: {
          e1: {
            requestId: 'e1',
            agentId: 'agent-1',
            sessionId: 's2',
            mode: 'form',
            message: 'Pick a branch',
            fields: []
          }
        }
      })
    })
    expect(result.current.needsAttention).toBe(false)
  })

  it('treats a closed session as Needs you and not live, with stale turn flags ignored', () => {
    seedOptionsSession('s1', 'agent-1', {
      status: 'closed',
      activeTurn: true,
      openTurnId: 't1'
    })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.needsAttention).toBe(true)
    expect(result.current.liveSession).toBe(false)
    expect(result.current.turnBusy).toBe(false)
  })

  it('treats a disconnected agent as Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    useAcpStore.setState({ agentStatus: { 'agent-1': 'disconnected' } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.needsAttention).toBe(true)
  })

  it('treats an ephemeral session as not live and never Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { activeTurn: true, openTurnId: 't1' })
    _addEphemeralSessionIdForTesting('s1')
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.liveSession).toBe(false)
    expect(result.current.turnBusy).toBe(false)
    expect(result.current.needsAttention).toBe(false)
  })

  it('returns an all-false record for a missing session', () => {
    const { result } = renderHook(() => useAgentChatStatusSignals('missing'))

    expect(result.current).toEqual({
      session: undefined,
      needsAttention: false,
      closing: false,
      liveSession: false,
      turnBusy: false
    })
  })
})
