import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatUnreadStore } from './agent-chat-unread-store'

beforeEach(() => {
  useAgentChatUnreadStore.setState({ unread: {} })
})

describe('useAgentChatUnreadStore', () => {
  it('starts with nothing unread', () => {
    expect(useAgentChatUnreadStore.getState().unread).toEqual({})
  })

  it('marks and clears one session without touching the others', () => {
    const { markUnread, clearUnread } = useAgentChatUnreadStore.getState()

    markUnread('a')
    markUnread('b')
    expect(useAgentChatUnreadStore.getState().unread).toEqual({ a: true, b: true })

    clearUnread('a')
    expect(useAgentChatUnreadStore.getState().unread).toEqual({ b: true })
  })

  it('keeps the same state object when marking an already-unread session', () => {
    const { markUnread } = useAgentChatUnreadStore.getState()
    markUnread('a')
    const before = useAgentChatUnreadStore.getState().unread

    markUnread('a')

    // No new record, so subscribers selecting `unread` do not re-render.
    expect(useAgentChatUnreadStore.getState().unread).toBe(before)
  })

  it('keeps the same state object when clearing a session that is not unread', () => {
    useAgentChatUnreadStore.getState().markUnread('a')
    const before = useAgentChatUnreadStore.getState().unread

    useAgentChatUnreadStore.getState().clearUnread('missing')

    expect(useAgentChatUnreadStore.getState().unread).toBe(before)
  })

  it('ignores an empty session id', () => {
    useAgentChatUnreadStore.getState().markUnread('')
    expect(useAgentChatUnreadStore.getState().unread).toEqual({})
  })
})
