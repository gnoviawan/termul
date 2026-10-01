import { beforeEach, describe, expect, it } from 'vitest'
import { retainedAgentChatSessionIds, useAgentChatLifetimeStore } from './agent-chat-lifetime-store'

describe('agent chat lifetime', () => {
  beforeEach(() => {
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {},
      closingSessionIds: {}
    })
  })

  it('keeps an Agent chat when its Project leaves the screen, and drops it on close', () => {
    useAgentChatLifetimeStore.getState().retainProjectChats('project-a', ['s1', 's2'])
    useAgentChatLifetimeStore.getState().retainProjectChats('project-a', ['s2'])
    expect(useAgentChatLifetimeStore.getState().retainedByProject['project-a']).toEqual([
      's1',
      's2'
    ])
    useAgentChatLifetimeStore.getState().releaseChat('s1')
    expect(
      retainedAgentChatSessionIds(useAgentChatLifetimeStore.getState().retainedByProject)
    ).toEqual(new Set(['s2']))
  })

  it('opens the chat you left, and a needs-you click wins once', () => {
    const store = useAgentChatLifetimeStore.getState()
    store.rememberActiveChat('project-a', 's1')
    store.requestFocus('project-a', 's2')
    expect(useAgentChatLifetimeStore.getState().takeFocus('project-a')).toBe('s2')
    expect(useAgentChatLifetimeStore.getState().takeFocus('project-a')).toBe('s1')
  })

  it('marks Closing and clears it when the chat is released', () => {
    useAgentChatLifetimeStore.getState().markClosing('s1')
    expect(useAgentChatLifetimeStore.getState().closingSessionIds.s1).toBe(true)
    useAgentChatLifetimeStore.getState().releaseChat('s1')
    expect(useAgentChatLifetimeStore.getState().closingSessionIds.s1).toBeUndefined()
  })
})
