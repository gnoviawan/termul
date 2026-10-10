import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatProjectSignals } from './use-agent-chat-attention'

function addElicitation(sessionId: string): void {
  act(() => {
    useAcpStore.setState({
      pendingElicitations: {
        [`e-${sessionId}`]: {
          requestId: `e-${sessionId}`,
          agentId: 'agent-1',
          sessionId,
          mode: 'form',
          message: 'Pick a branch',
          fields: []
        }
      }
    })
  })
}

describe('useAgentChatProjectSignals', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    _resetEphemeralSessionIdsForTesting()
    useAgentChatLifetimeStore.setState({ retainedByProject: {} })
    useAcpStore.setState({ agentStatus: { 'agent-1': 'connected' } })
  })

  it('is quiet for live idle chats', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({})
    expect(result.current.firstNeedsYouSessionId).toEqual({})
  })

  it('counts a chat with a pending elicitation for the pill, status bar and sidebar', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    const { result } = renderHook(() => useAgentChatProjectSignals())
    expect(result.current.attentionCounts.p1).toBeUndefined()

    addElicitation('s1')

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
    expect(result.current.firstNeedsYouSessionId).toEqual({ p1: 's1' })
  })

  it('does not count an elicitation on a chat of another project in this project', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    seedOptionsSession('s2', 'agent-1', { projectId: 'p2' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'], p2: ['s2'] } })
    addElicitation('s2')

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts.p1).toBeUndefined()
    expect(result.current.attentionCounts.p2).toBe(1)
    expect(result.current.firstNeedsYouSessionId.p1).toBeUndefined()
    expect(result.current.firstNeedsYouSessionId.p2).toBe('s2')
  })

  it('ignores an elicitation on an ephemeral warm-up session', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    _addEphemeralSessionIdForTesting('s1')
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    addElicitation('s1')

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({})
    expect(result.current.firstNeedsYouSessionId).toEqual({})
  })

  it('drops the count when the elicitation is answered', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    addElicitation('s1')
    const { result } = renderHook(() => useAgentChatProjectSignals())
    expect(result.current.attentionCounts).toEqual({ p1: 1 })

    act(() => {
      useAcpStore.setState({ pendingElicitations: {} })
    })

    expect(result.current.attentionCounts).toEqual({})
  })
})
