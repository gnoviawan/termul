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

function BrowserWebviewHarness({ visible = true }: { visible?: boolean }): JSX.Element {
  const { containerRef } = useBrowserWebview('browser-1', visible, 'https://example.com')
  return <div ref={containerRef} />
}

/** A fixed logical-px rect (the contract: bounds stay in CSS/DIP units). */
const LOGICAL_RECT = {
  x: 120.5,
  y: 48.25,
  width: 640.75,
  height: 360.5,
  top: 48.25,
  right: 761.25,
  bottom: 408.75,
  left: 120.5,
  toJSON: () => ({})
}

describe('useBrowserWebview bounds updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resizeCallback = null
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(LOGICAL_RECT)
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

    // After creation resolves, the post-create resync polls frames until the
    // rect stabilizes, then re-measures + shows. Await the resync resize and
    // the show so the counts below are deterministic.
    await waitFor(() => expect(browserTabResize).toHaveBeenCalledTimes(1))
    expect(browserTabResize).toHaveBeenLastCalledWith('browser-1', {
      x: 120.5,
      y: 48.25,
      width: 640.75,
      height: 360.5
    })
    await waitFor(() => expect(browserTabShow).toHaveBeenCalledTimes(1))

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver)
      resizeCallback?.([], {} as ResizeObserver)
    })

    await waitFor(() => expect(browserTabResize).toHaveBeenCalledTimes(3))
    expect(browserTabResize).toHaveBeenLastCalledWith('browser-1', {
      x: 120.5,
      y: 48.25,
      width: 640.75,
      height: 360.5
    })
    expect(consoleLog).not.toHaveBeenCalled()

    view.unmount()
  })

  it('resyncs to settled bounds after creation, not stale creation bounds (#644)', async () => {
    // Simulate the pane layout still mid-transition at creation time: the
    // container reports a wide (unsettled) rect while browserTabCreate is in
    // flight, then settles to the real narrower pane width before the
    // post-create resync reads it. Without the resync the webview would keep
    // the wide creation bounds and overflow into the adjacent pane.
    let measureCount = 0
    const wideRect = { ...LOGICAL_RECT, width: 1646, right: 1766.5 }
    const settledRect = { ...LOGICAL_RECT, width: 928, right: 1048.5 }
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
      this: HTMLElement
    ) {
      measureCount += 1
      // Creation-time measure (call 1) sees the wide/unsettled rect; every
      // later measure sees the settled rect.
      return measureCount === 1 ? wideRect : settledRect
    })

    const view = render(<BrowserWebviewHarness />)

    await waitFor(() => expect(browserTabCreate).toHaveBeenCalledTimes(1))
    // Created with the stale/wide bounds measured at call time.
    expect(browserTabCreate).toHaveBeenLastCalledWith(
      'browser-1',
      'https://example.com',
      expect.objectContaining({ width: 1646 })
    )

    // The post-create resync must re-measure and adopt the *settled* width,
    // proving the webview does not keep the stale 1646px creation bounds.
    await waitFor(() => expect(browserTabResize).toHaveBeenCalledTimes(1))
    expect(browserTabResize).toHaveBeenLastCalledWith(
      'browser-1',
      expect.objectContaining({ width: 928 })
    )
    expect(browserTabResize).not.toHaveBeenLastCalledWith(
      'browser-1',
      expect.objectContaining({ width: 1646 })
    )

    view.unmount()
  })

  it('resyncs bounds even when hidden at creation so a later show is correctly sized', async () => {
    // Matrix: "Browser hidden at creation" — the tab mounts inactive. The
    // post-create resync must still run (the deferred show relies on correct
    // bounds) and the webview is hidden, not shown.
    const view = render(<BrowserWebviewHarness visible={false} />)

    await waitFor(() => expect(browserTabCreate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(browserTabResize).toHaveBeenCalledTimes(1))
    expect(browserTabResize).toHaveBeenLastCalledWith(
      'browser-1',
      expect.objectContaining({ width: 640.75 })
    )
    // Hidden path: hide is invoked, show is not.
    expect(browserTabHide).toHaveBeenCalled()
    expect(browserTabShow).not.toHaveBeenCalled()

    view.unmount()
  })

  it('aborts the post-create resync if the component unmounts mid-poll (mount-token guard)', async () => {
    // Verification gap (VG1/BH5): the mount-token guard inside the resync
    // closure is the only thing preventing a stale resize/show/hide IPC after
    // unmount. Unmount immediately after creation resolves — before the stable-
    // bounds poll settles — and assert no show/resize fires post-destroy.
    const view = render(<BrowserWebviewHarness />)
    // Wait for create to resolve and flip createdRef, but unmount before the
    // rAF poll can settle the rect and call updateBounds/show.
    await waitFor(() => expect(browserTabCreate).toHaveBeenCalledTimes(1))
    view.unmount()
    // Drain any pending microtasks/rAF callbacks; the guard must short-circuit.
    await act(async () => {
      await Promise.resolve()
    })
    // The poll never reached its stable-frame branch, so no resync resize and
    // no show occurred (destroy ran in the effect cleanup instead).
    expect(browserTabResize).not.toHaveBeenCalled()
    expect(browserTabShow).not.toHaveBeenCalled()
    expect(browserTabDestroy).toHaveBeenCalled()
  })
})
