import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import type { LeafNode } from '@/types/workspace.types'
import { deserializePaneTree } from './pane-tree'
import type { PersistedPaneNodeInput } from './types'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

const USER_TAB = 'tab-0b7c2d1e-5f60-4a1b-9c2d-3e4f5a6b7c8d'

function restore(browserTabId: string): LeafNode {
  const persisted: PersistedPaneNodeInput = {
    type: 'leaf',
    id: 'pane-1',
    tabs: [{ type: 'browser', browserTabId, url: 'https://example.com/saved' }],
    activeTabId: null
  }
  return deserializePaneTree(persisted) as LeafNode
}

describe('browser tab restore', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  it('keeps a user tab label', () => {
    expect(restore(USER_TAB).tabs).toEqual([
      { type: 'browser', id: `browser-${USER_TAB}`, browserTabId: USER_TAB }
    ])
    expect(useBrowserSessionStore.getState().getTab(USER_TAB)?.url).toBe(
      'https://example.com/saved'
    )
  })

  it.each([
    ['an agent tab whose session ended', 'agent-1c8d3e2f-6071-4b2c-8d3e-4f5a6b7c8d9e'],
    ['a label from an older build', '1c8d3e2f-6071-4b2c-8d3e-4f5a6b7c8d9e']
  ])('reopens %s as a new user tab at its URL', (_, saved) => {
    const [tab] = restore(saved).tabs
    if (tab?.type !== 'browser') throw new Error('expected a browser tab')
    expect(tab.browserTabId).toMatch(/^tab-[0-9a-f-]{36}$/)
    expect(tab.id).toBe(`browser-${tab.browserTabId}`)
    expect(useBrowserSessionStore.getState().getTab(tab.browserTabId)?.url).toBe(
      'https://example.com/saved'
    )
    expect(useBrowserSessionStore.getState().getTab(saved)).toBeUndefined()
  })
})
