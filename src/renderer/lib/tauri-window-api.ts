import type { AppCloseRequestedCallback, IpcResult, WindowApi } from '@shared/types/ipc.types'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isWindows } from './platform'

/**
 * Wrap window operations in IpcResult<T> pattern with try/catch
 */
async function wrapWindowOperation<T>(
  fn: () => Promise<T>,
  errorCode: string
): Promise<IpcResult<T>> {
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
 * Returns true when running inside a real Tauri WebView (not a plain browser).
 * Tauri injects window.__TAURI_INTERNALS__ before any page script runs.
 */
function isTauriContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
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
      if (!isTauriContext())
        return { success: false, error: 'Not in Tauri context', code: 'NO_TAURI' }
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
      if (!isTauriContext())
        return () => {
          /* noop in browser */
        }
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
      if (!isTauriContext())
        return () => {
          /* noop in browser */
        }
      const window = getCurrentWindow()
      const unlisten = window.onCloseRequested(async (event) => {
        if (!isWindows) {
          // macOS/Linux close hides to the tray. Do not enter the renderer's
          // destroy-after-flush quit flow; tray Quit emits a separate event.
          event.preventDefault()
          try {
            await window.hide()
          } catch (error) {
            console.error('Failed to hide window to tray:', error)
          }
          return
        }

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
