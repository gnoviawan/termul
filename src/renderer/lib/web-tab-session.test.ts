import { afterEach, describe, expect, it } from 'vitest'
import {
  clearChatClosedOnRoute,
  isChatClosedOnRoute,
  markChatClosedOnRoute
} from '@/lib/web-tab-session'

describe('closed-on-route mark (route-gated)', () => {
  afterEach(() => {
    // Reset the hash AND clear marks between tests.
    window.location.hash = ''
    for (const id of ['s-a', 's-b']) clearChatClosedOnRoute(id)
  })

  it('marks when the route is on the session', () => {
    window.location.hash = '#/c/s-a'
    markChatClosedOnRoute('s-a')
    expect(isChatClosedOnRoute('s-a')).toBe(true)
  })

  it('does not mark when the route has moved to another chat', () => {
    window.location.hash = '#/c/s-b'
    markChatClosedOnRoute('s-a')
    expect(isChatClosedOnRoute('s-a')).toBe(false)
  })

  it('does not mark when the route left the chat surface entirely', () => {
    window.location.hash = '#/'
    markChatClosedOnRoute('s-a')
    expect(isChatClosedOnRoute('s-a')).toBe(false)
  })

  it('does not mark when no hash exists', () => {
    window.location.hash = ''
    markChatClosedOnRoute('s-a')
    expect(isChatClosedOnRoute('s-a')).toBe(false)
  })

  it('clear removes the mark', () => {
    window.location.hash = '#/c/s-a'
    markChatClosedOnRoute('s-a')
    clearChatClosedOnRoute('s-a')
    expect(isChatClosedOnRoute('s-a')).toBe(false)
  })
})
