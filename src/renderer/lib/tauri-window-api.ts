import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import type { AppCloseRequestedCallback, IpcResult, WindowApi } from '@shared/types/ipc.types'

/**
 * Wrap window operations in IpcResult<T> pattern with try/catch
 */
async function wrapWindowOperation<T>(fn: () => Promise<T>, errorCode: string): Promise<IpcResult<T>> {
  try {
    const data = await fn()
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: errorCode
    }
  }
}

/**
 * Wrap void window operations in IpcResult<void> pattern
 */
async function wrapVoidOperation(fn: () => Promise<void>, errorCode: string): Promise<IpcResult<void>> {
  try {
    await fn()
    return { success: true, data: undefined }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: errorCode
    }
  }
}

/**
 * Returns true when running inside a real Tauri WebView (not a plain browser).
 * Tauri injects window.__TAURI_INTERNALS__ before any page script runs.
 */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
}

/**
 * Create a WindowApi implementation using Tauri's window API
 *
 * This uses @tauri-apps/api/window directly instead of IPC commands,
 * providing better TypeScript types and performance.
 */
export function createTauriWindowApi(): WindowApi {
  return {
    minimize(): void {
      if (!isTauriContext()) return
      void getCurrentWindow().minimize()
    },

    async toggleMaximize(): Promise<IpcResult<boolean>> {
      if (!isTauriContext()) return { success: false, error: 'Not in Tauri context', code: 'NO_TAURI' }
      return wrapWindowOperation(async () => {
        const window = getCurrentWindow()
        if (await window.isMaximized()) {
          await window.unmaximize()
          return false
        } else {
          await window.maximize()
          return true
        }
      }, 'MAXIMIZE_ERROR')
    },

    close(): void {
      if (!isTauriContext()) return
      void getCurrentWindow().close()
    },

    onMaximizeChange(callback: (isMaximized: boolean) => void): () => void {
      if (!isTauriContext()) return () => { /* noop in browser */ }
      const window = getCurrentWindow()
      const unlisten = window.onResized(async () => {
        const maximized = await window.isMaximized()
        callback(maximized)
      })
      // Return sync cleanup function - unwrap the Promise
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    onCloseRequested(callback: AppCloseRequestedCallback): () => void {
      if (!isTauriContext()) return () => { /* noop in browser */ }
      const window = getCurrentWindow()
      const unlisten = window.onCloseRequested(async (event) => {
        const shouldClose = await callback()
        if (!shouldClose) {
          event.preventDefault()
        }
      })
      // Return sync cleanup function - unwrap the Promise
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    respondToClose(response: 'close' | 'cancel'): void {
      if (!isTauriContext()) return
      if (response === 'close') {
        void getCurrentWindow().destroy()
      }
      // If 'cancel', do nothing - close already prevented by onCloseRequested
    }
  }
}

/**
 * Direct export singleton for convenience (matches api-bridge pattern)
 */
export const tauriWindowApi = {
  async minimize(): Promise<IpcResult<void>> {
    return wrapVoidOperation(() => getCurrentWindow().minimize(), 'MINIMIZE_ERROR')
  },

  async toggleMaximize(): Promise<IpcResult<void>> {
    return wrapVoidOperation(async () => {
      const window = getCurrentWindow()
      if (await window.isMaximized()) {
        await window.unmaximize()
      } else {
        await window.maximize()
      }
    }, 'MAXIMIZE_ERROR')
  },

  async close(): Promise<IpcResult<void>> {
    return wrapVoidOperation(() => getCurrentWindow().close(), 'CLOSE_ERROR')
  },

  async isMaximized(): Promise<IpcResult<boolean>> {
    return wrapWindowOperation(() => getCurrentWindow().isMaximized(), 'STATE_ERROR')
  },

  onMaximizeChange(callback: (maximized: boolean) => void): () => void {
    const window = getCurrentWindow()
    const unlisten = window.onResized(async () => {
      const maximized = await window.isMaximized()
      callback(maximized)
    })
    // Return sync cleanup function - unwrap the Promise
    return () => {
      void unlisten.then((fn) => fn())
    }
  },

  onCloseRequested(callback: () => Promise<boolean>): () => void {
    const window = getCurrentWindow()
    const unlisten = window.onCloseRequested(async (event) => {
      const shouldClose = await callback()
      if (!shouldClose) {
        event.preventDefault()
      }
    })
    // Return sync cleanup function - unwrap the Promise
    return () => {
      void unlisten.then((fn) => fn())
    }
  },

  async setPosition(x: number, y: number): Promise<IpcResult<void>> {
    return wrapVoidOperation(
      () => getCurrentWindow().setPosition(new LogicalPosition(x, y)),
      'POSITION_ERROR'
    )
  },

  async setSize(width: number, height: number): Promise<IpcResult<void>> {
    return wrapVoidOperation(
      () => getCurrentWindow().setSize(new LogicalSize(width, height)),
      'SIZE_ERROR'
    )
  },

  async getPosition(): Promise<IpcResult<{ x: number; y: number }>> {
    return wrapWindowOperation(async () => {
      const pos = await getCurrentWindow().outerPosition()
      return { x: pos.x, y: pos.y }
    }, 'POSITION_ERROR')
  },

  async getSize(): Promise<IpcResult<{ width: number; height: number }>> {
    return wrapWindowOperation(async () => {
      const size = await getCurrentWindow().outerSize()
      return { width: size.width, height: size.height }
    }, 'SIZE_ERROR')
  }
}
