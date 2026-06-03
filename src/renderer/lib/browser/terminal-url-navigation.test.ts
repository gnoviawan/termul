import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { DEFAULT_APP_SETTINGS, type TerminalUrlOpenMode } from '@/types/settings'

const { mockOpenUrlWithSystemBrowser } = vi.hoisted(() => ({
  mockOpenUrlWithSystemBrowser: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  openerApi: {
    openUrlWithSystemBrowser: mockOpenUrlWithSystemBrowser
  }
}))

import {
  openTerminalUrl,
  openTerminalUrlInDedicatedBrowser,
  TERMINAL_DEDICATED_BROWSER_TAB_ID
} from './terminal-url-navigation'

describe('terminal-url-navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS },
      isLoaded: true
    })
    useBrowserSessionStore.setState({ tabs: new Map() })
    useWorkspaceStore.setState(() => ({
      root: { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null },
      activePaneId: 'pane-root',
      fullscreenPaneId: null
    }))
    mockOpenUrlWithSystemBrowser.mockResolvedValue({ success: true, data: undefined })
  })

  it('opens URLs in the system browser when mode is system', async () => {
    await openTerminalUrl('https://example.com')

    expect(mockOpenUrlWithSystemBrowser).toHaveBeenCalledWith('https://example.com')
    expect(useBrowserSessionStore.getState().tabs.size).toBe(0)
    const root = useWorkspaceStore.getState().root
    expect(root.type).toBe('leaf')
    if (root.type !== 'leaf') {
      throw new Error('Expected root pane to be a leaf')
    }
    expect(root.tabs).toHaveLength(0)
  })

  it('opens URLs in a new Termul browser tab when mode is termul', async () => {
    useAppSettingsStore.setState((state) => ({
      ...state,
      settings: { ...state.settings, terminalUrlOpenMode: 'termul' }
    }))

    await openTerminalUrl('https://example.com')

    expect(mockOpenUrlWithSystemBrowser).not.toHaveBeenCalled()
    const tabs = Array.from(useBrowserSessionStore.getState().tabs.values())
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.url).toBe('https://example.com')

    const root = useWorkspaceStore.getState().root
    expect(root.type).toBe('leaf')
    if (root.type !== 'leaf') {
      throw new Error('Expected root pane to be a leaf')
    }

    expect(root.tabs).toHaveLength(1)
    expect(root.tabs[0]).toMatchObject({
      type: 'browser',
      browserTabId: tabs[0]?.id,
      id: `browser-${tabs[0]?.id}`
    })
  })

  it('throws when system browser opening fails', async () => {
    mockOpenUrlWithSystemBrowser.mockResolvedValueOnce({
      success: false,
      error: 'open failed',
      code: 'OPEN_URL_ERROR'
    })

    await expect(openTerminalUrl('https://example.com')).rejects.toThrow('open failed')
  })

  it('treats an invalid persisted mode as system browser mode', async () => {
    useAppSettingsStore.setState((state) => ({
      ...state,
      settings: {
        ...state.settings,
        terminalUrlOpenMode: 'invalid-mode' as TerminalUrlOpenMode
      }
    }))

    await openTerminalUrl('https://example.com')

    expect(mockOpenUrlWithSystemBrowser).toHaveBeenCalledWith('https://example.com')
    expect(useBrowserSessionStore.getState().tabs.size).toBe(0)
  })

  it('always creates a dedicated Termul browser tab helper tab id', async () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001')

    await openTerminalUrlInDedicatedBrowser('https://example.com')

    const tab = useBrowserSessionStore
      .getState()
      .getTab(`${TERMINAL_DEDICATED_BROWSER_TAB_ID}-00000000-0000-4000-8000-000000000001`)

    expect(tab?.url).toBe('https://example.com')
    randomUuidSpy.mockRestore()
  })
})
