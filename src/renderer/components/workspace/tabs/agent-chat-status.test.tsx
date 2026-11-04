import { act, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { RESUME_FAILED_PREFIX } from '@/stores/acp-store/helpers'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import {
  AgentChatStatusGlyphs,
  agentChatStatusSlots,
  useAgentChatStatusSignals
} from './agent-chat-status'

const IDLE = {
  needsAttention: false,
  turnBusy: false,
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

  it('shows New activity for an unread chat', () => {
    expect(agentChatStatusSlots({ ...IDLE, unread: true }).statuses).toEqual(['New activity'])
    // A turn in flight hides the dot until it finishes.
    expect(agentChatStatusSlots({ ...IDLE, unread: true, turnBusy: true }).showUnread).toBe(false)
  })

  it('shows Needs you alongside Working', () => {
    const slots = agentChatStatusSlots({ ...IDLE, needsAttention: true, turnBusy: true })
    expect(slots.statuses).toEqual(['Needs you', 'Working'])
    expect(slots.statusText).toBe('Needs you, Working')
  })

  it('orders statuses Needs you, Working, New activity', () => {
    expect(agentChatStatusSlots({ ...IDLE, needsAttention: true, unread: true }).statusText).toBe(
      'Needs you, New activity'
    )
  })
})

describe('AgentChatStatusGlyphs', () => {
  const NONE = { needsAttention: false, showWorking: false, showUnread: false }

  it('renders nothing when no slot is active', () => {
    const { container } = render(<AgentChatStatusGlyphs {...NONE} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders each glyph with its title and sr-only text', () => {
    render(<AgentChatStatusGlyphs needsAttention showWorking={false} showUnread={false} />)
    expect(screen.getByTitle('Needs you')).toHaveClass('text-warning')
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
    resetChatActivity()
  })

  it('reads an idle chat', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.session?.id).toBe('s1')
    expect(result.current).toMatchObject({ needsAttention: false, turnBusy: false, unread: false })
  })

  it('reads Working, Needs you and New activity from the host, opened here or not', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    const { result } = renderHook(() => ({
      opened: useAgentChatStatusSignals('s1'),
      remote: useAgentChatStatusSignals('remote')
    }))

    act(() =>
      seedChatActivity({
        s1: { busy: true },
        remote: { needsYou: true, unread: true, turnEnd: { seq: 5, logEpoch: 'e1' } }
      })
    )
    expect(result.current.opened).toMatchObject({ turnBusy: true, needsAttention: false })
    expect(result.current.remote).toEqual({
      session: undefined,
      needsAttention: true,
      turnBusy: false,
      unread: true
    })
  })

  it("ignores turn flags and pending prompts on this renderer's own record", () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat', activeTurn: true, openTurnId: 't1' })
    useAcpStore.setState({
      pendingPermissions: {
        r1: { requestId: 'r1', agentId: 'agent-1', sessionId: 's1', options: [], toolCall: null }
      }
    })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current).toMatchObject({ needsAttention: false, turnBusy: false })
  })

  it('hides New activity on a chat this renderer shows', () => {
    seedChatActivity({ s1: { unread: true, turnEnd: { seq: 5, logEpoch: 'e1' } } }, ['s1'])
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.unread).toBe(false)
    act(() => seedChatActivity({ s1: { unread: true, turnEnd: { seq: 5, logEpoch: 'e1' } } }))
    expect(result.current.unread).toBe(true)
  })

  it('keeps New activity on an unread closed chat', () => {
    seedOptionsSession('s1', 'agent-1', { status: 'closed' })
    seedChatActivity({ s1: { unread: true, turnEnd: { seq: 5, logEpoch: 'e1' } } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    const slots = agentChatStatusSlots(result.current)
    expect(slots.showUnread).toBe(true)
    expect(slots.showWorking).toBe(false)
    expect(slots.statuses).toEqual(['New activity'])
  })

  it.each([
    ['a failed resume', `${RESUME_FAILED_PREFIX}agent exited`],
    ['a Codex sign-out', CODEX_CLI_SIGNED_OUT_MESSAGE]
  ])('treats a closed session after %s as Needs you', (_label, lastError) => {
    seedOptionsSession('s1', 'agent-1', { status: 'closed', lastError })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.needsAttention).toBe(true)
  })

  it('treats a cleanly closed session as not Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { status: 'closed' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.needsAttention).toBe(false)
  })

  it('treats a disconnected agent as Needs you', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat' })
    useAcpStore.setState({ agentStatus: { 'agent-1': 'disconnected' } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.needsAttention).toBe(true)
  })

  it('shows nothing for an ephemeral session, whatever the host says', () => {
    seedOptionsSession('s1', 'agent-1', {})
    _addEphemeralSessionIdForTesting('s1')
    seedChatActivity({ s1: { busy: true, needsYou: true, unread: true } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current).toMatchObject({ needsAttention: false, turnBusy: false, unread: false })
  })

  it('returns an all-false record for a chat the host has nothing on', () => {
    const { result } = renderHook(() => useAgentChatStatusSignals('missing'))

    expect(result.current).toEqual({
      session: undefined,
      needsAttention: false,
      turnBusy: false,
      unread: false
    })
  })
})
