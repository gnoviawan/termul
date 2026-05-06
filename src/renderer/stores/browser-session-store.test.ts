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
})
