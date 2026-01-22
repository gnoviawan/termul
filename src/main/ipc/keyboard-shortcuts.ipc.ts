/**
 * Keyboard Shortcuts IPC handlers
 *
 * Bridges renderer keyboard shortcuts API calls to KeyboardShortcutsManager service in main process.
 * All handlers use IpcResult<T> pattern for consistent error handling.
 * Source: Story 3.3 - Task 2: Create Keyboard Shortcuts IPC Channels
 */

import { ipcMain } from 'electron'
import { KeyboardShortcutsManager, KeyboardShortcutError } from '../services/keyboard-shortcuts-manager'
import type {
  IpcResult,
  IpcErrorCode
} from '../../shared/types/ipc.types'
import type {
  KeyboardShortcut,
  Keybinding,
  ShortcutRemapResult,
  UpdateShortcutDto,
  KeyboardShortcutErrorCodeType
} from '../../shared/types/keyboard-shortcuts.types'

/**
 * Keyboard shortcut error codes for IPC
 */
const KeyboardShortcutErrorCodes: Record<string, KeyboardShortcutErrorCodeType> = {
  SHORTCUT_NOT_FOUND: 'SHORTCUT_NOT_FOUND',
  SHORTCUT_ALREADY_EXISTS: 'SHORTCUT_ALREADY_EXISTS',
  SHORTCUT_CONFLICT: 'SHORTCUT_CONFLICT',
  RESERVED_SHORTCUT: 'RESERVED_SHORTCUT',
  INVALID_KEYBINDING: 'INVALID_KEYBINDING',
  SAVE_FAILED: 'SAVE_FAILED',
  LOAD_FAILED: 'LOAD_FAILED'
} as const

/**
 * Map KeyboardShortcutError to IpcResult format
 */
function mapErrorToIpcResult(error: unknown): IpcResult<never> {
  if (error instanceof KeyboardShortcutError) {
    return {
      success: false,
      error: error.message,
      code: error.code as IpcErrorCode
    }
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
    code: 'UNKNOWN_ERROR'
  }
}

/**
 * Singleton instance of KeyboardShortcutsManager
 */
let keyboardShortcutsManager: KeyboardShortcutsManager | null = null

/**
 * Get or create keyboard shortcuts manager instance
 */
function getManager(): KeyboardShortcutsManager {
  if (!keyboardShortcutsManager) {
    keyboardShortcutsManager = new KeyboardShortcutsManager()
  }
  return keyboardShortcutsManager
}

/**
 * Register keyboard shortcuts IPC handlers
 *
 * Handler registration must happen before app.ready() to prevent timing issues.
 * Task 2.1: Create electron/main/ipc/keyboard-shortcuts.ipc.ts file
 */
export function registerKeyboardShortcutsIpc(): void {
  // Task 2.2: Implement keyboard-shortcuts:list handler
  ipcMain.handle(
    'keyboard-shortcuts:list',
    async (): Promise<IpcResult<KeyboardShortcut[]>> => {
      try {
        const manager = getManager()
        const shortcuts = await manager.listShortcuts()

        return {
          success: true,
          data: shortcuts
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 2.3: Implement keyboard-shortcuts:update handler
  ipcMain.handle(
    'keyboard-shortcuts:update',
    async (_event, dto: UpdateShortcutDto): Promise<IpcResult<KeyboardShortcut>> => {
      try {
        const manager = getManager()
        const result = await manager.updateShortcut(dto.shortcutId, dto.keybinding)

        if (!result.success) {
          // Handle conflict errors
          if (result.conflict) {
            return {
              success: false,
              error: `Conflict with existing shortcut: ${result.conflict.existingShortcut.description}`,
              code: 'SHORTCUT_CONFLICT'
            }
          }

          return {
            success: false,
            error: result.error || 'Failed to update shortcut',
            code: 'SAVE_FAILED'
          }
        }

        // Return updated shortcut
        const shortcuts = await manager.listShortcuts()
        const updatedShortcut = shortcuts.find(s => s.id === dto.shortcutId)

        return {
          success: true,
          data: updatedShortcut!
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 2.4: Implement keyboard-shortcuts:reset handler
  ipcMain.handle(
    'keyboard-shortcuts:reset',
    async (): Promise<IpcResult<KeyboardShortcut[]>> => {
      try {
        const manager = getManager()
        const shortcuts = await manager.resetToDefaults()

        return {
          success: true,
          data: shortcuts
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 2.5: Implement keyboard-shortcuts:get-shortcut handler
  ipcMain.handle(
    'keyboard-shortcuts:get-shortcut',
    async (_event, command: string): Promise<IpcResult<KeyboardShortcut | null>> => {
      try {
        const manager = getManager()
        const shortcut = manager.getShortcutForCommand(command)

        return {
          success: true,
          data: shortcut || null
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )

  // Task 2.6: Implement keyboard-shortcuts:format-keybinding handler
  ipcMain.handle(
    'keyboard-shortcuts:format-keybinding',
    async (_event, keybinding: Keybinding): Promise<IpcResult<string>> => {
      try {
        const manager = getManager()
        const formatted = manager.formatKeybinding(keybinding)

        return {
          success: true,
          data: formatted
        }
      } catch (error) {
        return mapErrorToIpcResult(error)
      }
    }
  )
}
