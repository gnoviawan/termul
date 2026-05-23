import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useBrowserWebview } from './use-browser-webview'

const mocks = vi.hoisted(() => ({
  browserTabCreate: vi.fn(),
  browserTabDestroy: vi.fn(),
  browserTabHide: vi.fn(),
  browserTabNavigate: vi.fn(),
  browserTabResize: vi.fn(),
  browserTabShow: vi.fn(),
  isTauriContext: vi.fn(() => false),
}))

vi.mock('@/lib/browser-api', () => ({
  browserTabCreate: mocks.browserTabCreate,
  browserTabDestroy: mocks.browserTabDestroy,
  browserTabHide: mocks.browserTabHide,
  browserTabNavigate: mocks.browserTabNavigate,
  browserTabResize: mocks.browserTabResize,
  browserTabShow: mocks.browserTabShow,
  onBrowserTabNavigated: vi.fn(() => ({ unlisten: vi.fn() })),
  onBrowserTabLoaded: vi.fn(() => ({ unlisten: vi.fn() })),
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mocks.isTauriContext,
}))

describe('useBrowserWebview', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.isTauriContext.mockReturnValue(false)
    useBrowserSessionStore.setState({ tabs: new Map() })
  })

  afterEach(() => {
    cleanup()
  })

  it('skips native webview creation outside Tauri and clears loading', async () => {
    useBrowserSessionStore.getState().createTab('tab-1', 'https://example.com')

    renderHook(() => useBrowserWebview('tab-1', true, 'https://example.com'))

    await waitFor(() => {
      expect(useBrowserSessionStore.getState().tabs.get('tab-1')?.loading).toBe(false)
    })

    expect(mocks.browserTabCreate).not.toHaveBeenCalled()
    expect(mocks.browserTabDestroy).not.toHaveBeenCalled()
  })
})
