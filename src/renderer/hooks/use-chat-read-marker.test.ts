import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ markChatRead: vi.fn() }))
vi.mock('@/lib/chat-read-sync', () => sync)

import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { useChatReadMarker } from './use-chat-read-marker'

let visibility: DocumentVisibilityState = 'visible'
let focused = true

function setVisibility(next: DocumentVisibilityState): void {
  act(() => {
    visibility = next
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function turnEnd(sessionId: string, seq: number): void {
  act(() => useAgentChatUnreadStore.getState().noteTurnEnd(sessionId, seq))
}

beforeEach(() => {
  visibility = 'visible'
  focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  sync.markChatRead.mockReset()
  sync.markChatRead.mockImplementation((sessionId: string, seq: number) =>
    useAgentChatUnreadStore.getState().setReadMark(sessionId, seq)
  )
  useAgentChatUnreadStore.setState({
    unread: {},
    unreadSince: {},
    seenTurnEndSeq: {},
    sharedReadSeq: {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useChatReadMarker', () => {
  it('reports a shown chat read up to its newest turn end, on show and on each later turn end', () => {
    turnEnd('a', 4)
    turnEnd('b', 6)
    renderHook(() => useChatReadMarker(['a']))
    expect(sync.markChatRead.mock.calls).toEqual([['a', 4]])

    turnEnd('a', 11)
    turnEnd('b', 12)

    expect(sync.markChatRead.mock.calls).toEqual([
      ['a', 4],
      ['a', 11]
    ])
  })

  it('reports nothing the host marker already covers', () => {
    act(() => useAgentChatUnreadStore.getState().setReadMarks({ a: 9 }))
    turnEnd('a', 9)

    renderHook(() => useChatReadMarker(['a']))

    expect(sync.markChatRead).not.toHaveBeenCalled()
  })

  it('reads nothing while the page is hidden, and catches up when it is shown', () => {
    visibility = 'hidden'
    turnEnd('a', 4)
    renderHook(() => useChatReadMarker(['a']))
    turnEnd('a', 8)
    expect(sync.markChatRead).not.toHaveBeenCalled()

    setVisibility('visible')

    expect(sync.markChatRead.mock.calls).toEqual([['a', 8]])
  })

  it('reads nothing while the window is unfocused, and catches up on focus', () => {
    focused = false
    turnEnd('a', 4)
    renderHook(() => useChatReadMarker(['a']))
    expect(sync.markChatRead).not.toHaveBeenCalled()

    act(() => {
      focused = true
      window.dispatchEvent(new Event('focus'))
    })

    expect(sync.markChatRead.mock.calls).toEqual([['a', 4]])
  })
})
