/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTabFocusedSessionId,
  getTabFocusedSessionId,
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
