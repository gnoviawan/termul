import { beforeEach, describe, expect, it, vi } from 'vitest'

const { hide, onCloseRequested, platformState } = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined),
  onCloseRequested: vi.fn(),
  platformState: { isWindows: false }
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    hide,
    onCloseRequested,
    minimize: vi.fn(),
    isMaximized: vi.fn(async () => false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    onResized: vi.fn(async () => vi.fn())
  }),
  LogicalPosition: class LogicalPosition {},
  LogicalSize: class LogicalSize {}
}))

vi.mock('./platform', () => ({
  get isWindows() {
    return platformState.isWindows
  }
}))

describe('createTauriWindowApi close behavior', () => {
  beforeEach(() => {
    hide.mockClear()
    onCloseRequested.mockReset()
    onCloseRequested.mockResolvedValue(vi.fn())
    platformState.isWindows = false
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })

  it('hides and prevents close on non-Windows without entering the quit callback', async () => {
    const { createTauriWindowApi } = await import('./tauri-window-api')
    const callback = vi.fn(async () => false)
    createTauriWindowApi().onCloseRequested(callback)

    const closeHandler = onCloseRequested.mock.calls[0]?.[0] as
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined
    const preventDefault = vi.fn()
    await closeHandler?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(hide).toHaveBeenCalledOnce()
    expect(callback).not.toHaveBeenCalled()
  })

  it('logs hide failures while keeping the non-Windows close prevented', async () => {
    const error = new Error('hide failed')
    hide.mockRejectedValueOnce(error)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { createTauriWindowApi } = await import('./tauri-window-api')
    const callback = vi.fn(async () => false)
    createTauriWindowApi().onCloseRequested(callback)

    const closeHandler = onCloseRequested.mock.calls[0]?.[0] as
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined
    const preventDefault = vi.fn()
    await closeHandler?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith('Failed to hide window to tray:', error)
    expect(callback).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('uses the renderer quit callback on Windows', async () => {
    platformState.isWindows = true
    const { createTauriWindowApi } = await import('./tauri-window-api')
    const callback = vi.fn(async () => false)
    createTauriWindowApi().onCloseRequested(callback)

    const closeHandler = onCloseRequested.mock.calls[0]?.[0] as
      | ((event: { preventDefault: () => void }) => Promise<void>)
      | undefined
    const preventDefault = vi.fn()
    await closeHandler?.({ preventDefault })

    expect(callback).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(hide).not.toHaveBeenCalled()
  })
})
