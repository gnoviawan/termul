import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserTabCreate,
  browserTabDestroy,
  browserTabHide,
  browserTabResize,
  browserTabShow
} from '@/lib/browser-api'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useBrowserWebview } from './use-browser-webview'

vi.mock('@/lib/browser-api', () => ({
  browserTabCreate: vi.fn(),
  browserTabDestroy: vi.fn(),
  browserTabHide: vi.fn(),
  browserTabNavigate: vi.fn(),
  browserTabResize: vi.fn(),
  browserTabShow: vi.fn(),
  onBrowserTabLoaded: vi.fn(() => ({ unlisten: vi.fn() })),
  onBrowserTabNavigated: vi.fn(() => ({ unlisten: vi.fn() }))
}))

let resizeCallback: ResizeObserverCallback | null = null

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function BrowserWebviewHarness(): JSX.Element {
  const { containerRef } = useBrowserWebview('browser-1', true, 'https://example.com')
  return <div ref={containerRef} />
}

describe('useBrowserWebview bounds updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resizeCallback = null
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120.5,
      y: 48.25,
      width: 640.75,
      height: 360.5,
      top: 48.25,
      right: 761.25,
      bottom: 408.75,
      left: 120.5,
      toJSON: () => ({})
    })
    vi.mocked(browserTabCreate).mockResolvedValue({
      success: true,
      data: { id: 'browser-1', url: 'https://example.com', title: '' }
    })
    vi.mocked(browserTabDestroy).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(browserTabResize).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(browserTabShow).mockResolvedValue({ success: true, data: undefined })
    vi.mocked(browserTabHide).mockResolvedValue({ success: true, data: undefined })
    useBrowserSessionStore.getState().createTab('browser-1', 'https://example.com')
  })

  afterEach(() => {
    useBrowserSessionStore.getState().removeTab('browser-1')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps DOM bounds in logical pixels without resize diagnostic logging', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const view = render(<BrowserWebviewHarness />)

    await waitFor(() => expect(browserTabCreate).toHaveBeenCalledTimes(1))
    expect(browserTabCreate).toHaveBeenCalledWith('browser-1', 'https://example.com', {
      x: 120.5,
      y: 48.25,
      width: 640.75,
      height: 360.5
    })

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver)
      resizeCallback?.([], {} as ResizeObserver)
    })

    await waitFor(() => expect(browserTabResize).toHaveBeenCalledTimes(2))
    expect(browserTabResize).toHaveBeenLastCalledWith('browser-1', {
      x: 120.5,
      y: 48.25,
      width: 640.75,
      height: 360.5
    })
    expect(consoleLog).not.toHaveBeenCalled()

    view.unmount()
  })
})
