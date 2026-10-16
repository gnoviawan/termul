import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatUnreadStore } from './agent-chat-unread-store'

beforeEach(() => {
  useAgentChatUnreadStore.setState({
    unread: {},
    unreadSince: {},
    seenTurnEndSeq: {},
    sharedReadSeq: {}
  })
})

function unread(): Record<string, true> {
  return useAgentChatUnreadStore.getState().unread
}

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

  it('clears a dot once another surface read the turn end that raised it', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 12)
    store.markUnread('a', 4)
    store.markUnread('b', 0)

    store.setReadMark('a', 12)

    expect(unread()).toEqual({ b: true })
  })

  it('keeps the dot when the other surface read only an earlier turn', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 12)
    store.markUnread('a', 4)

    store.setReadMark('a', 8)

    expect(unread()).toEqual({ a: true })
  })

  it('keeps a dot whose turn end was never seen here, through every later sweep', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 10)
    store.setReadMark('a', 10)
    store.markUnread('a', 10)

    store.noteTurnEnd('b', 11)
    store.setReadMarks({ a: 10 })

    expect(unread()).toEqual({ a: true })
  })

  it('clears that dot once a later turn end is seen and read elsewhere', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 10)
    store.markUnread('a', 10)
    store.noteTurnEnd('a', 25)

    store.setReadMark('a', 25)

    expect(unread()).toEqual({})
  })

  it('keeps a merged dot when a later turn ended with no turn end seen and the read covers only the first', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 10)
    store.markUnread('a', 0)
    store.markUnread('a', 10)

    store.setReadMark('a', 10)

    expect(unread()).toEqual({ a: true })
  })

  it('banks no dot for a turn end another surface already read', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 12)
    store.setReadMark('a', 12)

    store.markUnread('a', 4)

    expect(unread()).toEqual({})
  })

  it('defaults a dot to needing a turn end newer than the newest seen now', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 12)
    store.markUnread('a')

    store.setReadMark('a', 12)

    expect(unread()).toEqual({ a: true })
  })

  it('never lowers the newest turn end seen', () => {
    const store = useAgentChatUnreadStore.getState()
    store.noteTurnEnd('a', 30)
    store.noteTurnEnd('a', 12)

    expect(useAgentChatUnreadStore.getState().seenTurnEndSeq).toEqual({ a: 30 })
  })
})
