import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserSessionStore } from './browser-session-store'

describe('browser-session-store', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  it('creates a tab with default values', () => {
    const tab = useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')
    expect(tab.id).toBe('tab-1')
    expect(tab.url).toBe('https://example.com')
    expect(tab.loading).toBe(true)
    expect(tab.canGoBack).toBe(false)
    expect(tab.canGoForward).toBe(false)
  })

  it('ensureTab reuses existing tab and updates URL', () => {
    const store = useBrowserSessionStore.getState()
    store.createTab('tab-1', 'https://old.example.com')

    const ensured = store.ensureTab('tab-1', 'https://new.example.com')

    expect(ensured.id).toBe('tab-1')
    expect(useBrowserSessionStore.getState().getTab('tab-1')?.url).toBe('https://new.example.com')
    expect(useBrowserSessionStore.getState().tabs.size).toBe(1)
  })

  it('ensureTab creates tab when missing', () => {
    const store = useBrowserSessionStore.getState()

    const ensured = store.ensureTab('tab-2', 'https://example.com')

    expect(ensured.id).toBe('tab-2')
    expect(useBrowserSessionStore.getState().getTab('tab-2')?.url).toBe('https://example.com')
    expect(useBrowserSessionStore.getState().tabs.size).toBe(1)
  })
})
