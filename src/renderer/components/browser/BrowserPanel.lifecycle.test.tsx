import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { BrowserPanel } from './BrowserPanel'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import {
  browserTabInjectAnnotation,
  browserTabRemoveAnnotationOverlay,
} from '@/lib/browser-api'

// Isolate the annotation lifecycle effects from the webview/marker/capture hooks
// and heavy child components.
vi.mock('@/hooks/use-browser-webview', () => ({
  useBrowserWebview: () => ({ containerRef: { current: null } }),
}))
vi.mock('@/hooks/use-annotation-capture', () => ({
  useAnnotationCapture: () => {},
}))
vi.mock('@/hooks/use-annotation-markers', () => ({
  useAnnotationMarkers: () => {},
}))
vi.mock('./BrowserControls', () => ({ BrowserControls: () => null }))
vi.mock('./AnnotationPanel', () => ({ AnnotationPanel: () => null }))
vi.mock('./AnnotationExportModal', () => ({ AnnotationExportModal: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/lib/browser-api', () => ({
  browserTabInjectAnnotation: vi.fn(),
  browserTabRemoveAnnotationOverlay: vi.fn(),
  browserTabHide: vi.fn().mockResolvedValue({ success: true }),
  browserTabShow: vi.fn().mockResolvedValue({ success: true }),
  onBrowserTabTitleChanged: vi.fn(() => ({ unlisten: vi.fn() })),
  onBrowserTabLoaded: vi.fn(() => ({ unlisten: vi.fn() })),
}))

const mockInject = browserTabInjectAnnotation as ReturnType<typeof vi.fn>
const mockRemove = browserTabRemoveAnnotationOverlay as ReturnType<typeof vi.fn>

// A deferred promise helper so we can control IPC resolution timing.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const TAB = 'tab-1'
const URL = 'https://example.com'

function flush() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BrowserPanel annotation lifecycle serialization (Finding A)', () => {
  beforeEach(() => {
    useBrowserSessionStore.setState({ tabs: new Map() })
    useBrowserSessionStore.getState().createTab(TAB, URL)
    useBrowserSessionStore.getState().setAnnotationMode(TAB, true)
    // createTab defaults loading=true; the reconciler defers inject while loading,
    // so clear it to exercise the steady-state lifecycle.
    useBrowserSessionStore.getState().setLoading(TAB, false)
    mockInject.mockReset()
    mockRemove.mockReset()
    mockInject.mockResolvedValue({ success: true })
    mockRemove.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('injects when annotation mode is on and the tab is visible', async () => {
    render(<BrowserPanel browserTabId={TAB} isVisible={true} />)
    await flush()

    expect(mockInject).toHaveBeenCalledWith(TAB, 'draw')
  })

  it('serializes a hide→show flip: the pending remove settles before the next inject', async () => {
    // Make the first remove hang so a show can be requested while it is in flight.
    const removeGate = deferred<{ success: boolean }>()
    mockRemove.mockReturnValueOnce(removeGate.promise)

    const { rerender } = render(<BrowserPanel browserTabId={TAB} isVisible={true} />)
    await flush()
    expect(mockInject).toHaveBeenCalledTimes(1) // initial inject

    // Hide → triggers a remove that we hold open.
    rerender(<BrowserPanel browserTabId={TAB} isVisible={false} />)
    await flush()
    expect(mockRemove).toHaveBeenCalledTimes(1)

    // Show again before the remove resolves. A naive implementation would
    // short-circuit on the cached mode and never re-inject; the serialized
    // reconciler must wait for the remove, then inject.
    rerender(<BrowserPanel browserTabId={TAB} isVisible={true} />)
    await flush()
    // No second inject yet — the chain is blocked on the pending remove.
    expect(mockInject).toHaveBeenCalledTimes(1)

    // Release the remove; the reconciler converges to the desired (visible) state.
    removeGate.resolve({ success: true })
    await flush()
    await flush()

    expect(mockInject).toHaveBeenCalledTimes(2)
    // Final injected state is the desired mode.
    expect(mockInject).toHaveBeenLastCalledWith(TAB, 'draw')
  })

  it('removes the overlay and does not re-inject when annotation mode turns off', async () => {
    const { rerender } = render(<BrowserPanel browserTabId={TAB} isVisible={true} />)
    await flush()
    expect(mockInject).toHaveBeenCalledTimes(1)

    act(() => {
      useBrowserSessionStore.getState().setAnnotationMode(TAB, false)
    })
    await flush()

    expect(mockRemove).toHaveBeenCalled()
    expect(mockInject).toHaveBeenCalledTimes(1) // no re-inject after off
  })

  it('stops retrying after a failed (security-blocked) injection', async () => {
    mockInject.mockReset()
    mockInject.mockResolvedValue({ success: false, error: 'blocked' })

    render(<BrowserPanel browserTabId={TAB} isVisible={true} />)
    await flush()
    await flush()

    // Should attempt once and then give up (desired reset to null), not loop.
    expect(mockInject).toHaveBeenCalledTimes(1)
  })
})
