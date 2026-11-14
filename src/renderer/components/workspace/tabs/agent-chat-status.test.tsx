import { act, renderHook } from '@testing-library/react'
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
import { useAgentChatStatusSignals } from './agent-chat-status'

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

  it('shows Working from the moment this renderer submits, before the host echoes the turn', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat', activeTurn: true, openTurnId: 't1' })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))

    expect(result.current.turnBusy).toBe(true)
    act(() => seedChatActivity({ s1: { busy: true } }))
    expect(result.current.turnBusy).toBe(true)
  })

  it('stops Working once Stop ends the turn here and on the host', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat', activeTurn: true, openTurnId: 't1' })
    seedChatActivity({ s1: { busy: true } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))
    expect(result.current.turnBusy).toBe(true)

    act(() => {
      seedOptionsSession('s1', 'agent-1', { title: 'Chat', activeTurn: false, openTurnId: null })
      seedChatActivity({ s1: { unread: true, turnEnd: { seq: 9, logEpoch: 'e1' } } })
    })
    expect(result.current).toMatchObject({ turnBusy: false, unread: true })
  })

  it('stops Working when Stop ends the agent work outside a turn', () => {
    seedOptionsSession('s1', 'agent-1', { title: 'Chat', agentWorking: true })
    seedChatActivity({ s1: { busy: true } })
    const { result } = renderHook(() => useAgentChatStatusSignals('s1'))
    expect(result.current.turnBusy).toBe(true)

    act(() => {
      seedOptionsSession('s1', 'agent-1', { title: 'Chat', agentWorking: false })
      seedChatActivity({})
    })
    expect(result.current.turnBusy).toBe(false)
  })

  it('ignores turn flags left on a record that is not live, and pending prompts held here', () => {
    seedOptionsSession('s1', 'agent-1', {
      title: 'Chat',
      status: 'closed',
      activeTurn: true,
      openTurnId: 't1'
    })
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

    expect(result.current.unread).toBe(true)
    expect(result.current.turnBusy).toBe(false)
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
