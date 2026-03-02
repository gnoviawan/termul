/**
 * Unified API exports for Tauri IPC
 *
 * This module re-exports all API singletons for easy importing.
 * Each API follows the IpcResult<T> pattern for consistent error handling.
 *
 * Runtime Detection:
 * - Tauri context: Uses Tauri-native adapters for session and data migration
 * - Electron context: Uses Electron IPC bridge via compatibility modules
 *
 * Usage:
 *   import { terminalApi, clipboardApi, systemApi } from '@/lib/api'
 */

export { terminalApi, addRendererRef, removeRendererRef } from './terminal-api'
export { clipboardApi } from './clipboard-api'
export { systemApi } from './system-api'
export { persistenceApi } from './persistence-api'
export { windowApi } from './window-api'
export { keyboardApi } from './keyboard-api'
export { visibilityApi } from './visibility-api'
export { filesystemApi } from './filesystem-api'
export { dialogApi } from './dialog-api'
export { shellApi } from './shell-api'
export * as tauriUpdaterApi from './tauri-updater-api'
export * as tauriVersionSkipService from './tauri-version-skip'
export { hasActiveTerminalSessions } from './tauri-safe-update'

// ============================================================================
// Session API - Tauri-first facade
// ============================================================================

/**
 * Detects if running in Tauri context.
 * Tauri injects window.__TAURI_INTERNALS__ before any page script runs.
 */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
}

// Tauri adapter
import { tauriSessionApi } from './tauri-session-api'
// Electron compatibility module
import { sessionApi as electronSessionApi } from './session-api'

/**
 * Session API facade - exports Tauri adapter in Tauri context,
 * Electron compatibility module in Electron context.
 *
 * No silent fallbacks - wrong context usage will fail explicitly.
 */
export const sessionApi = isTauriContext() ? tauriSessionApi : electronSessionApi

// ============================================================================
// Data Migration API - Tauri-first facade
// ============================================================================

// Tauri adapter (factory function, must be called)
import { createTauriDataMigrationApi } from './tauri-data-migration-api'
// Electron compatibility module
import { dataMigrationApi as electronDataMigrationApi } from './data-migration-api'

/**
 * Data Migration API facade - exports Tauri adapter in Tauri context,
 * Electron compatibility module in Electron context.
 *
 * No silent fallbacks - wrong context usage will fail explicitly.
 */
export const dataMigrationApi = isTauriContext()
  ? createTauriDataMigrationApi()
  : electronDataMigrationApi
