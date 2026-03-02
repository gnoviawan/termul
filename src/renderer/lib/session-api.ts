/**
 * Session Persistence API - Electron Compatibility Module
 *
 * @deprecated This is a compatibility module for Electron builds.
 * For Tauri builds, use tauri-session-api.ts instead.
 *
 * IMPORTANT: This module should only be used in Electron context.
 * When running in Tauri context, the facade in api.ts will automatically
 * route to tauriSessionApi. Using this module directly in Tauri context
 * will result in an explicit error.
 *
 * Migration Path:
 * - Electron builds: No change needed, api.ts facade handles routing
 * - Tauri builds: Use tauriSessionApi (exported via api.ts facade)
 *
 * @see tauri-session-api.ts - Tauri-native implementation
 * @see api.ts - Runtime-aware facade that selects the correct adapter
 */

import type { IpcResult, SessionData } from '@shared/types/ipc.types'

/**
 * Detects if running in Tauri context.
 * Used to prevent accidental usage of Electron module in Tauri context.
 */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
}

/**
 * Error result for wrong context usage
 */
function wrongContextError(operation: string): IpcResult<never> {
  return {
    success: false,
    error: `Session API operation '${operation}' called in wrong context. This is an Electron compatibility module, but running in Tauri context. Use api.ts facade instead.`,
    code: 'SESSION_API_WRONG_CONTEXT'
  }
}

/**
 * Check if we're in Electron context (window.api exists)
 */
function isElectronContext(): boolean {
  return typeof window !== 'undefined' && 'api' in window && typeof (window as any).api === 'object'
}

/**
 * Session API for renderer process (Electron compatibility)
 *
 * All operations return IpcResult<T> for consistent error handling.
 *
 * IMPORTANT: This will fail with explicit error if called in Tauri context.
 * Use the facade in api.ts for runtime-agnostic access.
 */
export const sessionApi = {
  /**
   * Save complete session data
   * @param sessionData - Complete session data including terminals and workspaces
   * @returns IpcResult<void>
   */
  save: async (sessionData: SessionData): Promise<IpcResult<void>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('save')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.session.save(sessionData)
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Session API not available - ensure running in Electron context',
      code: 'SESSION_API_UNAVAILABLE'
    }
  },

  /**
   * Restore session from disk
   * @returns IpcResult<SessionData>
   */
  restore: async (): Promise<IpcResult<SessionData>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('restore')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.session.restore()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Session API not available - ensure running in Electron context',
      code: 'SESSION_API_UNAVAILABLE'
    }
  },

  /**
   * Clear saved session from disk
   * @returns IpcResult<void>
   */
  clear: async (): Promise<IpcResult<void>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('clear')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.session.clear()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Session API not available - ensure running in Electron context',
      code: 'SESSION_API_UNAVAILABLE'
    }
  },

  /**
   * Flush any pending auto-save operations
   * Call this before app quit to ensure data is saved
   * @returns IpcResult<void>
   */
  flush: async (): Promise<IpcResult<void>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('flush')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.session.flush()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Session API not available - ensure running in Electron context',
      code: 'SESSION_API_UNAVAILABLE'
    }
  },

  /**
   * Check if a saved session exists
   * Useful for determining whether to show "Restore session?" prompt on startup
   * @returns IpcResult<boolean>
   */
  hasSession: async (): Promise<IpcResult<boolean>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('hasSession')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.session.hasSession()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Session API not available - ensure running in Electron context',
      code: 'SESSION_API_UNAVAILABLE'
    }
  }
} as const

// Type export for use in other modules
export type SessionApi = typeof sessionApi
