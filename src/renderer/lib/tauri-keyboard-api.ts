import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { KeyboardApi } from '@shared/types/ipc.types'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

/**
 * IPC Event names
 *
 * FALLBACK MODE: This event is NOT emitted by the backend.
 *
 * See decision document: docs/decisions/keyboard-system-event-mode-final.md
 *
 * In Electron, keyboard shortcuts are intercepted via `webContents.on('before-input-event')`
 * which allows capturing reserved browser shortcuts like Ctrl+Tab before Chromium handles them.
 *
 * In Tauri/WebView2, this capability is not available because:
 * - WebView2 does not expose a `before-input-event` hook
 * - Tauri's globalShortcut plugin requires global OS-level registration (different security model)
 * - Works even when app is unfocused (not desired for app-specific shortcuts)
 *
 * TODO: For full Backend Event Mode, would need:
 *   1. Rust globalShortcut registration using tauri-plugin-global-shortcut
 *   2. Backend emitter in src-tauri/src/commands.rs to forward events to renderer
 *   3. Security consideration - global shortcuts work even when app is unfocused
 *
 * CURRENT APPROACH (Fallback Mode):
 * - The listener below is registered but will NEVER fire (no backend emitter)
 * - Keyboard shortcuts should be handled via frontend keydown event listeners
 * - Some shortcuts (Ctrl+Tab) cannot be intercepted due to browser limitations
 * - Use app-scoped fallback shortcuts (e.g., Ctrl+PageDown/Ctrl+PageUp) where needed
 */
const IPC_EVENTS = {
  SHORTCUT: 'keyboard://shortcut'
} as const

/**
 * Create a KeyboardApi implementation using Tauri IPC
 *
 * FALLBACK MODE: Partial parity with Electron
 *
 * This implementation provides the KeyboardApi interface but does NOT receive
 * backend events for keyboard shortcuts. The `onShortcut` callback will never
 * be invoked from the Rust backend.
 *
 * For actual keyboard shortcut handling, use a React keydown handler:
 * - Most shortcuts (zoom, etc.) work via window.addEventListener('keydown')
 * - Reserved browser shortcuts (Ctrl+Tab) cannot be intercepted in WebView2
 * - Use alternative shortcuts (Ctrl+PageDown/PageUp, etc.)
 *
 * @returns KeyboardApi with onShortcut method (stub - never receives backend events)
 */
export function createTauriKeyboardApi(): KeyboardApi {
  return {
    onShortcut(callback: (shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset') => void): () => void {
      if (!isTauriContext()) {
        return () => {}
      }

      // NOTE: This listener is registered but the event is never emitted by the backend.
      // See FALLBACK MODE documentation above.
      let unlisten: Promise<UnlistenFn> | undefined

      try {
        unlisten = listen<string>(IPC_EVENTS.SHORTCUT, ({ payload }) => {
          callback(payload as 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset')
        })
      } catch (error) {
        console.error('[TauriKeyboardAPI] Failed to register shortcut listener:', error)
        return () => {}
      }

      return () => {
        cleanupTauriListener(unlisten)
      }
    }
  }
}
