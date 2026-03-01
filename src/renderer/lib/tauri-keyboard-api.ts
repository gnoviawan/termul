import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { KeyboardApi } from '@shared/types/ipc.types'

/**
 * IPC Event names
 */
const IPC_EVENTS = {
  SHORTCUT: 'keyboard://shortcut'
} as const

/**
 * Create a KeyboardApi implementation using Tauri IPC
 */
export function createTauriKeyboardApi(): KeyboardApi {
  return {
    onShortcut(callback: (shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset') => void): () => void {
      const unlisten = listen<string>(IPC_EVENTS.SHORTCUT, ({ payload }) => {
        callback(payload as 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset')
      })
      return () => {
        void unlisten.then((fn) => fn())
      }
    }
  }
}
