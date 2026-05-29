import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

import {
  tauriSecureStorageApi,
  createTauriSecureStorageApi,
  _resetSecureStorageForTesting
} from '../tauri-secure-storage-api'

describe('tauri-secure-storage-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetSecureStorageForTesting()
  })

  afterEach(() => {
    _resetSecureStorageForTesting()
  })

  describe('setSecret', () => {
    it('should successfully store a secret', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true })

      const result = await tauriSecureStorageApi.setSecret('test-key', 'test-value')

      expect(result.success).toBe(true)
      expect(invoke).toHaveBeenCalledWith('secure_storage_set', {
        request: {
          key: 'test-key',
          value: 'test-value'
        }
      })
    })

    it('should return error when storage fails', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: false,
        error: 'Storage failed',
        code: 'STORAGE_ERROR'
      })

      const result = await tauriSecureStorageApi.setSecret('test-key', 'test-value')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Storage failed')
        expect(result.code).toBe('STORAGE_ERROR')
      }
    })

    it('should handle invoke exceptions', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Network error'))

      const result = await tauriSecureStorageApi.setSecret('test-key', 'test-value')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Network error')
        expect(result.code).toBe('SECURE_STORAGE_ERROR')
      }
    })
  })

  describe('getSecret', () => {
    it('should successfully retrieve a secret', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: true,
        data: 'test-value'
      })

      const result = await tauriSecureStorageApi.getSecret('test-key')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe('test-value')
      }
      expect(invoke).toHaveBeenCalledWith('secure_storage_get', {
        request: {
          key: 'test-key'
        }
      })
    })

    it('should return error when key not found', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })

      const result = await tauriSecureStorageApi.getSecret('missing-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Key not found')
        expect(result.code).toBe('KEY_NOT_FOUND')
      }
    })

    it('should handle invoke exceptions', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Access denied'))

      const result = await tauriSecureStorageApi.getSecret('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Access denied')
        expect(result.code).toBe('SECURE_STORAGE_ERROR')
      }
    })
  })

  describe('deleteSecret', () => {
    it('should successfully delete a secret', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true })

      const result = await tauriSecureStorageApi.deleteSecret('test-key')

      expect(result.success).toBe(true)
      expect(invoke).toHaveBeenCalledWith('secure_storage_delete', {
        request: {
          key: 'test-key'
        }
      })
    })

    it('should return error when deletion fails', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: false,
        error: 'Deletion failed',
        code: 'DELETE_ERROR'
      })

      const result = await tauriSecureStorageApi.deleteSecret('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Deletion failed')
        expect(result.code).toBe('DELETE_ERROR')
      }
    })

    it('should handle invoke exceptions', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Permission denied'))

      const result = await tauriSecureStorageApi.deleteSecret('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Permission denied')
        expect(result.code).toBe('SECURE_STORAGE_ERROR')
      }
    })
  })

  describe('factory function', () => {
    it('should create a new instance', () => {
      const api = createTauriSecureStorageApi()
      expect(api).toBeDefined()
      expect(api.setSecret).toBeDefined()
      expect(api.getSecret).toBeDefined()
      expect(api.deleteSecret).toBeDefined()
    })
  })
})
