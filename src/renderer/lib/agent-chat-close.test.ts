import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeAgentChat } from '@/lib/agent-chat-close'
import { clearChatClosedOnRoute, isChatClosedOnRoute } from '@/lib/web-tab-session'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

describe('closeAgentChat', () => {
  beforeEach(() => {
    useAgentChatLifetimeStore.setState({
      retainedByProject: { p1: ['s1', 's2'] },
      activeSessionByProject: { p1: 's1' },
      focusSessionByProject: {}
    })
    window.location.hash = '#/c/s1'
  })

  afterEach(() => {
    clearChatClosedOnRoute('s1')
    window.location.hash = ''
  })

  it('releases the chat and marks the route closed before removing the tab', () => {
    const closeTab = vi.fn(() => {
      // By the time the tab goes, both signals must already be set.
      expect(isChatClosedOnRoute('s1')).toBe(true)
      expect(useAgentChatLifetimeStore.getState().retainedByProject.p1).toEqual(['s2'])
    })

    closeAgentChat('s1', closeTab)

    expect(closeTab).toHaveBeenCalledOnce()
    expect(useAgentChatLifetimeStore.getState().activeSessionByProject).toEqual({})
  })

  it('does not mark a chat closed when the route points elsewhere', () => {
    window.location.hash = '#/c/other'
    closeAgentChat('s1', vi.fn())
    expect(isChatClosedOnRoute('s1')).toBe(false)
  })
})
