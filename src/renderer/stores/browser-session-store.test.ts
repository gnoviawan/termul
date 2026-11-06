import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserSessionStore } from './browser-session-store'

const TAB = 'tab-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d'

describe('browser-session-store', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  it('creates a tab with default values', () => {
    const tab = useBrowserSessionStore.getState().createTab(TAB, 'https://example.com')
    expect(tab).toEqual({
      id: TAB,
      url: 'https://example.com',
      title: '',
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
  })

  it('mirrors the host registry view of a tab it knows', () => {
    const store = useBrowserSessionStore.getState()
    store.createTab(TAB, 'https://example.com')
    store.applyView({
      tabId: TAB,
      url: 'https://example.com/clicked',
      title: 'Clicked',
      loading: false,
      agentControlled: true,
      epoch: 2
    })
    expect(useBrowserSessionStore.getState().getTab(TAB)).toMatchObject({
      url: 'https://example.com/clicked',
      title: 'Clicked',
      loading: false,
      agentControlled: true
    })
  })

  it('ignores a view of a tab this window does not show', () => {
    useBrowserSessionStore.getState().applyView({
      tabId: TAB,
      url: 'https://example.com',
      title: '',
      loading: false,
      agentControlled: false,
      epoch: 1
    })
    expect(useBrowserSessionStore.getState().tabs.size).toBe(0)
  })
})
