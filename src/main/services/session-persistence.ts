import type { IpcResult } from '../../shared/types/ipc.types'
import { read, write, remove, PersistenceErrorCodes } from './persistence-service'
import type { TerminalInstance } from './pty-manager'

/**
 * Terminal session data for persistence
 * Subset of TerminalInstance with additional state for restoration
 */
export interface TerminalSession {
  id: string
  shell: string
  cwd: string
  history: string[]
  env?: Record<string, string>
}

/**
 * Workspace state for persistence
 * Contains workspace configuration and active terminals
 */
export interface WorkspaceState {
  projectId: string
  activeTerminalId: string | null
  terminals: TerminalSession[]
}

/**
 * Complete session data structure
 * Contains all application state needed to restore session on app launch
 */
export interface SessionData {
  timestamp: string
  terminals: TerminalSession[]
  workspaces: WorkspaceState[]
}

/**
 * Error codes for session persistence operations
 */
export const SessionPersistenceErrorCodes = {
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INVALID_SESSION_DATA: 'INVALID_SESSION_DATA',
  SAVE_FAILED: 'SAVE_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  CLEAR_FAILED: 'CLEAR_FAILED'
} as const

export type SessionPersistenceErrorCode =
  (typeof SessionPersistenceErrorCodes)[keyof typeof SessionPersistenceErrorCodes]

/**
 * Auto-save configuration
 */
const AUTO_SAVE_KEY = 'sessions/auto-save'
const AUTO_SAVE_DEBOUNCE_MS = 2000 // 2 seconds debounce for auto-save

/**
 * Convert TerminalInstance to TerminalSession for persistence
 * Filters out runtime-only data like PTY instance and renderer refs
 */
function terminalInstanceToSession(instance: TerminalInstance): TerminalSession {
  return {
    id: instance.id,
    shell: instance.shell,
    cwd: instance.cwd,
    history: [], // History is managed by renderer, empty on main process side
    env: undefined // Environment variables are not persisted for security
  }
}

/**
 * Session Persistence Service
 * Handles saving and restoring terminal sessions across app launches
 *
 * Features:
 * - Auto-save on terminal state changes
 * - Restore session on app launch
 * - Support for "Restoring session" indicator
 * - Atomic writes via persistence-service
 * - Debounced auto-save to avoid excessive disk I/O
 */
class SessionPersistenceService {
  private autoSaveTimeout: NodeJS.Timeout | null = null
  private lastSaveTimestamp: string = ''
  private pendingAutoSaveData: SessionData | null = null

  /**
   * Save complete session data manually
   * Used for explicit save operations (e.g., on app quit)
   */
  async saveSession(sessionData: SessionData): Promise<IpcResult<void>> {
    try {
      // Validate session data structure
      if (!this.validateSessionData(sessionData)) {
        return {
          success: false,
          error: 'Invalid session data structure',
          code: SessionPersistenceErrorCodes.INVALID_SESSION_DATA
        }
      }

      // Create a shallow clone to avoid mutating the input
      const timestamp = new Date().toISOString()
      const sessionDataClone = { ...sessionData, timestamp }
      this.lastSaveTimestamp = timestamp

      // Use persistence-service for atomic write
      const result = await write(AUTO_SAVE_KEY, sessionDataClone)

      if (!result.success) {
        return {
          success: false,
          error: `Failed to save session: ${result.error}`,
          code: SessionPersistenceErrorCodes.SAVE_FAILED
        }
      }

      return { success: true, data: undefined }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown save error',
        code: SessionPersistenceErrorCodes.SAVE_FAILED
      }
    }
  }

  /**
   * Save current terminal instances to session
   * Converts TerminalInstance array to SessionData format
   */
  async saveTerminalInstances(instances: TerminalInstance[]): Promise<IpcResult<void>> {
    const terminals = instances.map(terminalInstanceToSession)

    const sessionData: SessionData = {
      timestamp: new Date().toISOString(),
      terminals,
      workspaces: [] // Workspaces are managed separately by renderer
    }

    return this.saveSession(sessionData)
  }

  /**
   * Restore session from disk
   * Returns saved session data or error if not found/invalid
   */
  async restoreSession(): Promise<IpcResult<SessionData>> {
    try {
      const result = await read<SessionData>(AUTO_SAVE_KEY)

      if (!result.success) {
        // Handle specific error codes
        if (result.code === PersistenceErrorCodes.FILE_NOT_FOUND) {
          return {
            success: false,
            error: 'No saved session found',
            code: SessionPersistenceErrorCodes.SESSION_NOT_FOUND
          }
        }

        return {
          success: false,
          error: `Failed to read session: ${result.error}`,
          code: SessionPersistenceErrorCodes.RESTORE_FAILED
        }
      }

      const sessionData = result.data

      // Validate restored session data
      if (!this.validateSessionData(sessionData)) {
        return {
          success: false,
          error: 'Invalid session data structure',
          code: SessionPersistenceErrorCodes.INVALID_SESSION_DATA
        }
      }

      return { success: true, data: sessionData }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown restore error',
        code: SessionPersistenceErrorCodes.RESTORE_FAILED
      }
    }
  }

  /**
   * Auto-save session with debouncing
   * Coalesces rapid state changes into a single save operation
   * Use this for automatic saves triggered by terminal state changes
   */
  autoSave(sessionData: SessionData): void {
    // Store pending data for flush
    this.pendingAutoSaveData = sessionData

    // Clear any pending auto-save
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout)
    }

    // Schedule new auto-save
    this.autoSaveTimeout = setTimeout(async () => {
      this.autoSaveTimeout = null
      const result = await this.saveSession(sessionData)
      if (!result.success) {
        console.error('Auto-save failed:', result.error)
      }
      // Clear pending data after save
      this.pendingAutoSaveData = null
    }, AUTO_SAVE_DEBOUNCE_MS)
  }

  /**
   * Auto-save terminal instances with debouncing
   * Convenience method for auto-saving current terminal state
   */
  autoSaveTerminals(instances: TerminalInstance[]): void {
    const terminals = instances.map(terminalInstanceToSession)

    const sessionData: SessionData = {
      timestamp: new Date().toISOString(),
      terminals,
      workspaces: [] // Workspaces are managed separately by renderer
    }

    this.autoSave(sessionData)
  }

  /**
   * Clear saved session from disk
   * Use this when user explicitly clears session or on fresh start
   */
  async clearSession(): Promise<IpcResult<void>> {
    try {
      // Cancel any pending auto-save
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout)
        this.autoSaveTimeout = null
      }

      const result = await remove(AUTO_SAVE_KEY)

      if (!result.success) {
        return {
          success: false,
          error: `Failed to clear session: ${result.error}`,
          code: SessionPersistenceErrorCodes.CLEAR_FAILED
        }
      }

      this.lastSaveTimestamp = ''

      return { success: true, data: undefined }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown clear error',
        code: SessionPersistenceErrorCodes.CLEAR_FAILED
      }
    }
  }

  /**
   * Get last save timestamp
   * Useful for displaying "Last saved: X time ago" to user
   */
  getLastSaveTimestamp(): string {
    return this.lastSaveTimestamp
  }

  /**
   * Check if a saved session exists
   * Useful for determining whether to show "Restore session?" prompt on startup
   */
  async hasSavedSession(): Promise<boolean> {
    const result = await read<SessionData>(AUTO_SAVE_KEY)
    return result.success
  }

  /**
   * Flush any pending auto-save operations
   * Call this before app quit to ensure data is saved
   * Forces an immediate save if there's pending data
   */
  async flushPendingAutoSave(): Promise<void> {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout)
      this.autoSaveTimeout = null

      // If there's pending data, save it immediately
      if (this.pendingAutoSaveData) {
        const result = await this.saveSession(this.pendingAutoSaveData)
        if (!result.success) {
          console.error('Flush auto-save failed:', result.error)
        }
        this.pendingAutoSaveData = null
      }
    }
  }

  /**
   * Validate session data structure
   * Ensures all required fields are present and valid
   */
  private validateSessionData(data: unknown): data is SessionData {
    if (!data || typeof data !== 'object') {
      return false
    }

    const session = data as Partial<SessionData>

    // Check timestamp
    if (!session.timestamp || typeof session.timestamp !== 'string') {
      return false
    }

    // Check terminals array
    if (!Array.isArray(session.terminals)) {
      return false
    }

    // Validate each terminal session
    for (const terminal of session.terminals) {
      if (!terminal.id || typeof terminal.id !== 'string') {
        return false
      }
      if (!terminal.shell || typeof terminal.shell !== 'string') {
        return false
      }
      if (!terminal.cwd || typeof terminal.cwd !== 'string') {
        return false
      }
      if (!Array.isArray(terminal.history)) {
        return false
      }
    }

    // Check workspaces array
    if (!Array.isArray(session.workspaces)) {
      return false
    }

    // Validate each workspace
    for (const workspace of session.workspaces) {
      if (!workspace.projectId || typeof workspace.projectId !== 'string') {
        return false
      }
      if (workspace.activeTerminalId !== null && typeof workspace.activeTerminalId !== 'string') {
        return false
      }
      if (!Array.isArray(workspace.terminals)) {
        return false
      }
    }

    return true
  }

  /**
   * Clean up resources
   * Call this on app shutdown
   */
  destroy(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout)
      this.autoSaveTimeout = null
    }
  }
}

// Singleton instance
let defaultService: SessionPersistenceService | null = null

/**
 * Get the default session persistence service instance
 */
export function getDefaultSessionPersistenceService(): SessionPersistenceService {
  if (!defaultService) {
    defaultService = new SessionPersistenceService()
  }
  return defaultService
}

/**
 * Reset the default session persistence service
 * Useful for testing or app restart scenarios
 */
export function resetSessionPersistenceService(): void {
  if (defaultService) {
    defaultService.destroy()
    defaultService = null
  }
}
