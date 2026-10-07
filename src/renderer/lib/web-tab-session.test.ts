/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearChatClosedOnRoute,
  clearTabFocusedSessionId,
  getTabFocusedSessionId,
  isChatClosedOnRoute,
  markChatClosedOnRoute,
  setTabFocusedSessionId,
  WEB_TAB_FOCUSED_SESSION_KEY
} from './web-tab-session'

afterEach(() => {
  sessionStorage.clear()
})

describe('web-tab-session', () => {
  it('defaults to null when unset', () => {
    expect(getTabFocusedSessionId()).toBeNull()
  })

  it('persists focus within the same sessionStorage (same tab / refresh)', () => {
    setTabFocusedSessionId('session-a')
    expect(getTabFocusedSessionId()).toBe('session-a')
    expect(sessionStorage.getItem(WEB_TAB_FOCUSED_SESSION_KEY)).toBe('session-a')
  })

  it('clears focus via set(null) and clearTabFocusedSessionId', () => {
    setTabFocusedSessionId('session-a')
    setTabFocusedSessionId(null)
    expect(getTabFocusedSessionId()).toBeNull()

    setTabFocusedSessionId('session-b')
    clearTabFocusedSessionId()
    expect(getTabFocusedSessionId()).toBeNull()
  })

  it('treats empty string as clear (not a focused id)', () => {
    setTabFocusedSessionId('session-a')
    setTabFocusedSessionId('')
    expect(getTabFocusedSessionId()).toBeNull()
    expect(sessionStorage.getItem(WEB_TAB_FOCUSED_SESSION_KEY)).toBeNull()
  })

  it('isolates focus across simulated tabs (fresh sessionStorage context)', () => {
    // Tab 1
    setTabFocusedSessionId('session-tab1')
    expect(getTabFocusedSessionId()).toBe('session-tab1')

    // Simulate opening a new tab: clear storage (new browsing context).
    sessionStorage.clear()
    expect(getTabFocusedSessionId()).toBeNull()

    // Tab 2 sets a different focus — must not resurrect tab1's value.
    setTabFocusedSessionId('session-tab2')
    expect(getTabFocusedSessionId()).toBe('session-tab2')
    expect(getTabFocusedSessionId()).not.toBe('session-tab1')
  })
})

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
