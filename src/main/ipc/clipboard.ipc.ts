import { ipcMain, clipboard } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../shared/types/ipc.types'
import { IpcErrorCodes } from '../../shared/types/ipc.types'

// Maximum clipboard content size (10MB)
const MAX_CLIPBOARD_SIZE = 10 * 1024 * 1024

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function createErrorResult<T>(error: string, code: string): IpcResult<T> {
  return { success: false, error, code }
}

/**
 * Validates text input for clipboard operations
 * @param text - The text to validate
 * @returns Validation result with error message if invalid
 */
function validateTextInput(text: unknown): { valid: boolean; error?: string } {
  // Check if text is a string
  if (typeof text !== 'string') {
    return { valid: false, error: 'Invalid input: text must be a string' }
  }

  // Check for null or undefined (though typeof check above handles undefined)
  if (text === null) {
    return { valid: false, error: 'Invalid input: text cannot be null' }
  }

  // Check text length
  if (text.length > MAX_CLIPBOARD_SIZE) {
    return {
      valid: false,
      error: `Text exceeds maximum size of ${MAX_CLIPBOARD_SIZE} bytes`
    }
  }

  return { valid: true }
}

export function registerClipboardIpc(): void {
  // clipboard:readText - Read text from system clipboard
  ipcMain.handle(
    'clipboard:readText',
    async (_event: IpcMainInvokeEvent): Promise<IpcResult<string>> => {
      try {
        const text = clipboard.readText()
        return createSuccessResult(text)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error reading clipboard'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )

  // clipboard:writeText - Write text to system clipboard
  ipcMain.handle(
    'clipboard:writeText',
    async (_event: IpcMainInvokeEvent, text: string): Promise<IpcResult<void>> => {
      // Validate input
      const validation = validateTextInput(text)
      if (!validation.valid) {
        return createErrorResult(validation.error!, IpcErrorCodes.VALIDATION_ERROR)
      }

      try {
        clipboard.writeText(text)
        return createSuccessResult(undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error writing clipboard'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )
}

export function unregisterClipboardIpc(): void {
  ipcMain.removeHandler('clipboard:readText')
  ipcMain.removeHandler('clipboard:writeText')
}
