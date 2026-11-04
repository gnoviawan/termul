import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { RESUME_FAILED_PREFIX } from '@/stores/acp-store/helpers'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatProjectSignals } from './use-agent-chat-attention'

describe('useAgentChatProjectSignals', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    _resetEphemeralSessionIdsForTesting()
    resetChatActivity()
    useAgentChatLifetimeStore.setState({ retainedByProject: {} })
    useAcpStore.setState({ agentStatus: { 'agent-1': 'connected' } })
  })

  it('is quiet for live idle chats', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({})
    expect(result.current.firstNeedsYouSessionId).toEqual({})
    expect([...result.current.workingProjectIds]).toEqual([])
  })

  it('counts a chat this surface never opened under the project the host names', () => {
    seedChatActivity({ elsewhere: { needsYou: true, projectId: 'p1' } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
    expect(result.current.firstNeedsYouSessionId).toEqual({ p1: 'elsewhere' })
    expect([...result.current.needsYouChats]).toEqual([['elsewhere', 'p1']])
  })

  it('marks a project working while the host has a turn open in a chat this surface never opened', () => {
    seedChatActivity({ elsewhere: { busy: true, projectId: 'p2' } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect([...result.current.workingProjectIds]).toEqual(['p2'])
    expect(result.current.attentionCounts).toEqual({})
  })

  it("counts an opened chat's pending prompt once, from the host, in tab order first", () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    const { result } = renderHook(() => useAgentChatProjectSignals())
    expect(result.current.attentionCounts.p1).toBeUndefined()

    act(() => {
      seedChatActivity({
        a: { needsYou: true, projectId: 'p1' },
        s1: { needsYou: true, projectId: 'p1' }
      })
    })

    expect(result.current.attentionCounts).toEqual({ p1: 2 })
    expect(result.current.firstNeedsYouSessionId).toEqual({ p1: 's1' })

    act(() => {
      seedChatActivity({ a: { needsYou: true, projectId: 'p1' } })
    })

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
    expect(result.current.firstNeedsYouSessionId).toEqual({ p1: 'a' })
  })

  it("falls back to this surface's session for the project of a record that names none", () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    seedChatActivity({ s1: { needsYou: true, busy: true, projectId: null } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
    expect([...result.current.workingProjectIds]).toEqual(['p1'])
  })

  it('ignores a record with no project and no session to name one', () => {
    seedChatActivity({ unknown: { needsYou: true, busy: true, projectId: null } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({})
    expect([...result.current.workingProjectIds]).toEqual([])
  })

  it('ignores an ephemeral warm-up session', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    _addEphemeralSessionIdForTesting('s1')
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    seedChatActivity({ s1: { needsYou: true, busy: true, projectId: 'p1' } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({})
    expect([...result.current.workingProjectIds]).toEqual([])
  })

  it('counts a closed chat only when it cannot resume by itself', () => {
    seedOptionsSession('clean', 'agent-1', { projectId: 'p1', status: 'closed' })
    seedOptionsSession('failed', 'agent-1', {
      projectId: 'p1',
      status: 'closed',
      lastError: `${RESUME_FAILED_PREFIX}agent exited`
    })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['clean', 'failed'] } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
    expect(result.current.firstNeedsYouSessionId).toEqual({ p1: 'failed' })
  })

  it('counts a chat whose agent disconnected once, even when the host also holds its prompt', () => {
    seedOptionsSession('s1', 'agent-1', { projectId: 'p1' })
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['s1'] } })
    useAcpStore.setState({ agentStatus: { 'agent-1': 'disconnected' } })
    seedChatActivity({ s1: { needsYou: true, projectId: 'p1' } })

    const { result } = renderHook(() => useAgentChatProjectSignals())

    expect(result.current.attentionCounts).toEqual({ p1: 1 })
  })
})
