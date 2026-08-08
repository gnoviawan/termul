/**
 * Terminal API Singleton
 *
 * Exports a singleton instance of the TerminalApi for use throughout the app.
 * In Tauri context, uses the Tauri IPC implementation. In web context, uses
 * the websocket-backed implementation.
 *
 * Usage:
 *   import { terminalApi } from '@/lib/terminal-api'
 *   await terminalApi.spawn({ cwd: '/path' })
 */

import type { TerminalApi } from '@shared/types/ipc.types'
import { isTauriContext } from './tauri-runtime'
import { createTauriTerminalApi } from './tauri-terminal-api'
import { createWebTerminalApi } from './web-terminal-api'

/**
 * Singleton TerminalApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * Uses the websocket-backed implementation when running in a browser.
 */
export const terminalApi: TerminalApi = isTauriContext()
  ? createTauriTerminalApi()
  : createWebTerminalApi()

// Re-export internal renderer ref methods for ConnectedTerminal component.
// These come from tauri-terminal-api (they no-op outside Tauri, which is fine
// because the web adapter handles renderer refs via webTerminalInternals).
export { addRendererRef, removeRendererRef, setTerminalProtected } from './tauri-terminal-api'
