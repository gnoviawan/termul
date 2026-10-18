import { PersistenceKeys } from '@shared/types/persistence.types'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWindowState } from '@/hooks/use-window-state'
import { CLOSE_WRITE_TIMEOUT_MS } from '@/lib/close-flush'
import { useAppClose } from './use-app-close'

const {
  windowMock,
  persistenceMock,
  windowApiMock,
  runtimeMock,
  logMock,
  tauriEventHandlers,
  unmountCanvases
} = vi.hoisted(() => ({
  windowMock: {
    isMaximized: vi.fn(async () => false),
    scaleFactor: vi.fn(async () => 1),
    outerPosition: vi.fn(async () => ({ x: 40, y: 30 })),
    outerSize: vi.fn(async () => ({ width: 1100, height: 700 })),
    setPosition: vi.fn(async (_position: unknown) => {}),
    setSize: vi.fn(async (_size: unknown) => {}),
    maximize: vi.fn(async () => {}),
    onMoved: vi.fn(async () => vi.fn()),
    onResized: vi.fn(async () => vi.fn()),
    onCloseRequested: vi.fn(async (_handler: unknown) => vi.fn())
  },
  persistenceMock: {
    read: vi.fn(async () => ({ success: false, data: null })),
    write: vi.fn(async (_key: string, _value: unknown) => ({ success: true })),
    writeDebounced: vi.fn(async (_key: string, _value: unknown) => ({ success: true })),
    flushPendingWrites: vi.fn(async () => ({ success: true }))
  },
  windowApiMock: {
    onCloseRequested: vi.fn((_callback: () => Promise<boolean>) => () => {}),
    respondToClose: vi.fn((_response: 'close' | 'cancel') => {})
  },
  runtimeMock: { isTauri: true },
  logMock: vi.fn(async (_payload: unknown) => {}),
  tauriEventHandlers: new Map<string, () => void>(),
  unmountCanvases: vi.fn(async (_projectIds?: string[]) => true)
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMock,
  availableMonitors: async () => [],
  primaryMonitor: async () => null,
  LogicalPosition: class {},
  LogicalSize: class {}
}))
vi.mock('@/lib/api', () => ({ persistenceApi: persistenceMock, windowApi: windowApiMock }))
vi.mock('@/lib/tauri-wayland', () => ({ isWaylandSession: async () => false }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: (payload: unknown) => logMock(payload) }))
vi.mock('@/lib/tauri-window-api', () => ({ hasAppCloseOwner: () => true }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => runtimeMock.isTauri,
  cleanupTauriListener: (fn: unknown) => {
    if (typeof fn === 'function') fn()
  }
}))
vi.mock('@/lib/tauri-event', () => ({
  listen: async (event: string, handler: () => void) => {
    tauriEventHandlers.set(event, handler)
    return () => tauriEventHandlers.delete(event)
  }
}))
vi.mock('@/lib/acp-history-persistence', () => ({
  flushSessionHistory: async () => {},
  waitForPendingSessionIndexWrite: async () => {}
}))
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: { getState: () => ({ getDirtyFileCount: () => 0 }) }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/canvas-unmount-flow', () => ({ unmountCanvases }))

const geometry = { x: 40, y: 30, width: 1100, height: 700, isMaximized: false }

async function mountApp(): Promise<{
  requestAppClose: () => void
  fireWindowStateCloseListener: () => void
}> {
  renderHook(() => {
    useWindowState()
    return useAppClose()
  })
  await waitFor(() => expect(windowMock.onCloseRequested).toHaveBeenCalledOnce())
  const appCloseCallback = windowApiMock.onCloseRequested.mock.calls[0][0]
  const windowStateListener = windowMock.onCloseRequested.mock.calls[0][0] as (event: {
    preventDefault: () => void
  }) => void
  return {
    requestAppClose: () => void appCloseCallback(),
    fireWindowStateCloseListener: () => windowStateListener({ preventDefault: () => {} })
  }
}

function deferWindowStateWrite(): () => void {
  let land: () => void = () => {}
  persistenceMock.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        land = () => resolve({ success: true })
      })
  )
  return () => land()
}

describe('useAppClose window geometry flush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriEventHandlers.clear()
    runtimeMock.isTauri = true
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('destroys the window only after the close-time geometry write lands', async () => {
    const { requestAppClose, fireWindowStateCloseListener } = await mountApp()
    const landWrite = deferWindowStateWrite()

    await act(async () => {
      requestAppClose()
      fireWindowStateCloseListener()
    })
    await waitFor(() =>
      expect(persistenceMock.write).toHaveBeenCalledWith(PersistenceKeys.windowState, geometry)
    )
    expect(windowApiMock.respondToClose).not.toHaveBeenCalled()

    await act(async () => {
      landWrite()
    })
    await waitFor(() => expect(windowApiMock.respondToClose).toHaveBeenCalledWith('close'))
    expect(persistenceMock.write).toHaveBeenCalledOnce()
  })

  it('tray Quit destroys the window only after the geometry write lands', async () => {
    await mountApp()
    await waitFor(() => expect(tauriEventHandlers.has('tray:quit-requested')).toBe(true))
    const landWrite = deferWindowStateWrite()

    await act(async () => {
      tauriEventHandlers.get('tray:quit-requested')?.()
    })
    await waitFor(() =>
      expect(persistenceMock.write).toHaveBeenCalledWith(PersistenceKeys.windowState, geometry)
    )
    expect(windowApiMock.respondToClose).not.toHaveBeenCalled()

    await act(async () => {
      landWrite()
    })
    await waitFor(() => expect(windowApiMock.respondToClose).toHaveBeenCalledWith('close'))
    expect(persistenceMock.write).toHaveBeenCalledOnce()
  })

  it('still destroys the window when the geometry write hangs past the timeout', async () => {
    const { requestAppClose } = await mountApp()
    vi.useFakeTimers()
    persistenceMock.write.mockImplementationOnce(() => new Promise(() => {}))

    await act(async () => {
      requestAppClose()
      await vi.advanceTimersByTimeAsync(CLOSE_WRITE_TIMEOUT_MS - 1)
    })
    expect(persistenceMock.write).toHaveBeenCalledWith(PersistenceKeys.windowState, geometry)
    expect(windowApiMock.respondToClose).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(windowApiMock.respondToClose).toHaveBeenCalledWith('close')
    expect(logMock).toHaveBeenCalledWith({
      level: 'warn',
      source: 'use-window-state',
      message: `Close-time window state write timed out after ${CLOSE_WRITE_TIMEOUT_MS}ms; closing anyway`
    })
  })

  it('closes without a geometry write outside the Tauri context', async () => {
    runtimeMock.isTauri = false
    renderHook(() => {
      useWindowState()
      return useAppClose()
    })
    const appCloseCallback = windowApiMock.onCloseRequested.mock.calls[0][0]

    await act(async () => {
      void appCloseCallback()
    })

    await waitFor(() => expect(windowApiMock.respondToClose).toHaveBeenCalledWith('close'))
    expect(persistenceMock.write).not.toHaveBeenCalled()
  })
})

describe('useAppClose canvas unmount (AD-31)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriEventHandlers.clear()
    runtimeMock.isTauri = true
    unmountCanvases.mockResolvedValue(true)
  })

  it('closes only after every canvas was saved and unmounted', async () => {
    let unmounted: (value: boolean) => void = () => {}
    unmountCanvases.mockReturnValueOnce(new Promise((resolve) => (unmounted = resolve)))
    const { requestAppClose } = await mountApp()

    await act(async () => {
      requestAppClose()
    })
    expect(unmountCanvases).toHaveBeenCalledWith()
    expect(windowApiMock.respondToClose).not.toHaveBeenCalled()
    expect(persistenceMock.flushPendingWrites).not.toHaveBeenCalled()

    await act(async () => {
      unmounted(true)
    })
    await waitFor(() => expect(windowApiMock.respondToClose).toHaveBeenCalledWith('close'))
  })

  it('cancels the quit when the user keeps editing an unsaved canvas', async () => {
    unmountCanvases.mockResolvedValueOnce(false)
    const { requestAppClose } = await mountApp()

    await act(async () => {
      requestAppClose()
    })

    await waitFor(() => expect(windowApiMock.respondToClose).toHaveBeenCalledWith('cancel'))
    expect(windowApiMock.respondToClose).not.toHaveBeenCalledWith('close')
    expect(persistenceMock.flushPendingWrites).not.toHaveBeenCalled()
  })
})
