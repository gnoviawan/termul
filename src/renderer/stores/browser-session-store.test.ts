import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserSessionStore } from './browser-session-store'

describe('browser-session-store', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  it('defaults annotationSubMode to draw on tab creation', () => {
    const tab = useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')

    expect(tab.annotationSubMode).toBe('draw')
    expect(useBrowserSessionStore.getState().getTab('tab-1')?.annotationSubMode).toBe('draw')
  })

  it('updates annotationSubMode independently of annotationMode', () => {
    const store = useBrowserSessionStore.getState()
    store.createTab('tab-1', 'https://example.com')

    store.setAnnotationSubMode('tab-1', 'select')

    const tab = store.getTab('tab-1')
    expect(tab?.annotationSubMode).toBe('select')
    expect(tab?.annotationMode).toBe(false)
  })

  it('persists annotationSubMode when annotation mode toggles off and on', () => {
    const store = useBrowserSessionStore.getState()
    store.createTab('tab-1', 'https://example.com')

    store.setAnnotationSubMode('tab-1', 'select')
    store.setAnnotationMode('tab-1', true)
    store.setAnnotationMode('tab-1', false)
    store.setAnnotationMode('tab-1', true)

    const tab = store.getTab('tab-1')
    expect(tab?.annotationSubMode).toBe('select')
    expect(tab?.annotationMode).toBe(true)
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
