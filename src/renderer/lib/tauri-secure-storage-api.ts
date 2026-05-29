import { invoke } from '@tauri-apps/api/core'
import type { IpcResult } from '@shared/types/ipc.types'

/**
 * Secure storage API for storing sensitive data using OS-native secure storage
 * (Windows Credential Manager, macOS Keychain, Linux Secret Service)
 */
export interface SecureStorageApi {
  /**
   * Store a secret value securely
   * @param key - Unique identifier for the secret
   * @param value - Secret value to store
   */
  setSecret(key: string, value: string): Promise<IpcResult<void>>

  /**
   * Retrieve a secret value
   * @param key - Unique identifier for the secret
   */
  getSecret(key: string): Promise<IpcResult<string>>

  /**
   * Delete a secret value
   * @param key - Unique identifier for the secret
   */
  deleteSecret(key: string): Promise<IpcResult<void>>
}

/**
 * Create a Tauri-based secure storage API implementation
 */
export function createTauriSecureStorageApi(): SecureStorageApi {
  return {
    async setSecret(key: string, value: string): Promise<IpcResult<void>> {
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'secure_storage_set',
          { request: { key, value } }
        )

        if (!response.success) {
          return {
            success: false,
            error: response.error ?? 'Failed to store secret',
            code: response.code ?? 'STORAGE_ERROR'
          }
        }

        return { success: true, data: undefined }
      } catch (err) {
        return {
          success: false,
          error: String(err),
          code: 'SECURE_STORAGE_ERROR'
        }
      }
    },

    async getSecret(key: string): Promise<IpcResult<string>> {
      try {
        const response = await invoke<{
          success: boolean
          data?: string
          error?: string
          code?: string
        }>('secure_storage_get', { request: { key } })

        if (!response.success) {
          return {
            success: false,
            error: response.error ?? 'Failed to retrieve secret',
            code: response.code ?? 'KEY_NOT_FOUND'
          }
        }

        return { success: true, data: response.data ?? '' }
      } catch (err) {
        return {
          success: false,
          error: String(err),
          code: 'SECURE_STORAGE_ERROR'
        }
      }
    },

    async deleteSecret(key: string): Promise<IpcResult<void>> {
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'secure_storage_delete',
          { request: { key } }
        )

        if (!response.success) {
          return {
            success: false,
            error: response.error ?? 'Failed to delete secret',
            code: response.code ?? 'DELETE_ERROR'
          }
        }

        return { success: true, data: undefined }
      } catch (err) {
        return {
          success: false,
          error: String(err),
          code: 'SECURE_STORAGE_ERROR'
        }
      }
    }
  }
}

/**
 * Singleton instance for convenience
 */
export const tauriSecureStorageApi = createTauriSecureStorageApi()

/**
 * @internal Testing only - reset module state
 */
export function _resetSecureStorageForTesting(): void {
  // No state to reset in current implementation
  // This function exists for consistency with other API modules
}
