/**
 * Terminal API Singleton
 *
 * Exports a singleton instance of the TerminalApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { terminalApi } from '@/lib/terminal-api'
 *   await terminalApi.spawn({ cwd: '/path' })
 */

import { createTauriTerminalApi } from './tauri-terminal-api'
import type { TerminalApi } from '@shared/types/ipc.types'

/**
 * Singleton TerminalApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
export const terminalApi: TerminalApi = createTauriTerminalApi()

// Re-export internal renderer ref methods for ConnectedTerminal component
export { addRendererRef, removeRendererRef } from './tauri-terminal-api'
