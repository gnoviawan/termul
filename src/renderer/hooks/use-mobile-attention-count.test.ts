import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useMobileAttentionCount } from './use-mobile-attention-count'

describe('useMobileAttentionCount', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    resetChatActivity()
    useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['active'] } })
    useAcpStore.setState({ agentStatus: { a1: 'connected' } })
    seedOptionsSession('active', 'a1', { projectId: 'p1' })
  })

  it('counts the chats of the active project that need you, ones this phone never opened included', () => {
    seedChatActivity({
      'never-opened': { needsYou: true, projectId: 'p1' },
      'other-project': { needsYou: true, projectId: 'p2' }
    })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(1)
  })

  it('leaves out the chat on screen', () => {
    seedChatActivity({
      active: { needsYou: true, projectId: 'p1' },
      'never-opened': { needsYou: true, projectId: 'p1' }
    })
    expect(renderHook(() => useMobileAttentionCount('p1', 'active')).result.current).toBe(1)
    expect(renderHook(() => useMobileAttentionCount('p1', null)).result.current).toBe(2)
  })

  it('leaves out the chat on screen when only this phone knows it needs you', () => {
    useAcpStore.setState({ agentStatus: { a1: 'disconnected' } })
    seedChatActivity({ 'never-opened': { needsYou: true, projectId: 'p1' } })
    expect(renderHook(() => useMobileAttentionCount('p1', 'active')).result.current).toBe(1)
    expect(renderHook(() => useMobileAttentionCount('p1', null)).result.current).toBe(2)
  })

  it('returns 0 with no active project', () => {
    seedChatActivity({ 'never-opened': { needsYou: true, projectId: 'p1' } })
    expect(renderHook(() => useMobileAttentionCount(undefined, null)).result.current).toBe(0)
  })
})
