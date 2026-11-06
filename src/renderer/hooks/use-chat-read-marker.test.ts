import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ markChatRead: vi.fn() }))
vi.mock('@/lib/chat-read-sync', () => sync)

import type { LogPoint } from '@/lib/log-point'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { useChatReadMarker } from './use-chat-read-marker'

let visibility: DocumentVisibilityState = 'visible'
let focused = true

function setVisibility(next: DocumentVisibilityState): void {
  act(() => {
    visibility = next
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function at(seq: number, logEpoch = 'e1'): LogPoint {
  return { logEpoch, seq }
}

/** The host's records: each named chat has an unread turn end at `seq`. */
function unreadAt(turnEnds: Record<string, number>, read: Record<string, number> = {}): void {
  act(() =>
    seedChatActivity(
      Object.fromEntries([
        ...Object.entries(turnEnds).map(([sessionId, seq]) => [
          sessionId,
          { unread: true, turnEnd: { seq, logEpoch: 'e1' } }
        ]),
        ...Object.entries(read).map(([sessionId, seq]) => [
          sessionId,
          { unread: false, turnEnd: { seq, logEpoch: 'e1' } }
        ])
      ])
    )
  )
}

beforeEach(() => {
  visibility = 'visible'
  focused = true
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  sync.markChatRead.mockReset()
  resetChatActivity()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useChatReadMarker', () => {
  it('reports a shown chat read up to the turn end the host calls unread, on show and on each later one', () => {
    unreadAt({ a: 4, b: 6 })
    renderHook(() => useChatReadMarker(['a']))
    expect(sync.markChatRead.mock.calls).toEqual([['a', at(4)]])

    unreadAt({ a: 11, b: 12 })

    expect(sync.markChatRead.mock.calls).toEqual([
      ['a', at(4)],
      ['a', at(11)]
    ])
  })

  it('reports nothing the host already calls read', () => {
    unreadAt({}, { a: 9 })
    renderHook(() => useChatReadMarker(['a']))

    expect(sync.markChatRead).not.toHaveBeenCalled()
  })

  it('reads nothing while the page is hidden, and catches up when it is shown', () => {
    visibility = 'hidden'
    unreadAt({ a: 4 })
    renderHook(() => useChatReadMarker(['a']))
    unreadAt({ a: 8 })
    expect(sync.markChatRead).not.toHaveBeenCalled()

    setVisibility('visible')

    expect(sync.markChatRead.mock.calls).toEqual([['a', at(8)]])
  })

  it('reads nothing while the window is unfocused, and catches up on focus', () => {
    focused = false
    unreadAt({ a: 4 })
    renderHook(() => useChatReadMarker(['a']))
    expect(sync.markChatRead).not.toHaveBeenCalled()

    act(() => {
      focused = true
      window.dispatchEvent(new Event('focus'))
    })

    expect(sync.markChatRead.mock.calls).toEqual([['a', at(4)]])
  })
})
