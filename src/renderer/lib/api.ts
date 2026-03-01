/**
 * Unified API exports for Tauri IPC
 *
 * This module re-exports all API singletons for easy importing.
 * Each API follows the IpcResult<T> pattern for consistent error handling.
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
