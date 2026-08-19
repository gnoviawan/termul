/**
 * Unit tests for tauri-dialog-api.ts
 * Tests the tauriDialogApi implementation using Tauri plugin-dialog
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeUiLanguage } from '@/i18n'

// Mock @tauri-apps/plugin-dialog BEFORE importing
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true)
}))

import { confirm, message, open, save } from '@tauri-apps/plugin-dialog'
import { tauriDialogApi } from '../tauri-dialog-api'

const mockOpen = open as ReturnType<typeof vi.fn>
const mockSave = save as ReturnType<typeof vi.fn>
const mockMessage = message as ReturnType<typeof vi.fn>
const mockConfirm = confirm as ReturnType<typeof vi.fn>

describe('tauriDialogApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Restore default mocks
    mockOpen.mockResolvedValue(null)
    mockSave.mockResolvedValue(null)
    mockMessage.mockResolvedValue(undefined)
    mockConfirm.mockResolvedValue(true)
  })

  afterEach(async () => {
    await changeUiLanguage('en')
  })

  describe('selectDirectory', () => {
    it('should successfully select a directory', async () => {
      const testPath = '/home/user/projects'
      mockOpen.mockResolvedValue(testPath)

      const result = await tauriDialogApi.selectDirectory()

      expect(mockOpen).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: 'Select Project Folder'
      })
      expect(result).toEqual({
        success: true,
        data: testPath
      })
    })

    it('should handle dialog cancellation (null result)', async () => {
      mockOpen.mockResolvedValue(null)

      const result = await tauriDialogApi.selectDirectory()

      expect(result).toEqual({
        success: true,
        data: null
      })
    })

    it('should handle dialog errors', async () => {
      mockOpen.mockRejectedValue(new Error('Dialog error'))

      const result = await tauriDialogApi.selectDirectory()

      expect(result).toEqual({
        success: false,
        error: 'Error: Dialog error',
        code: 'DIALOG_ERROR'
      })
    })

    it('should handle string error messages', async () => {
      mockOpen.mockRejectedValue('Unknown dialog error')

      const result = await tauriDialogApi.selectDirectory()

      expect(result).toEqual({
        success: false,
        error: 'Unknown dialog error',
        code: 'DIALOG_ERROR'
      })
    })
  })

  describe('selectFile', () => {
    it('should successfully select a file', async () => {
      const testPath = '/home/user/file.txt'
      mockOpen.mockResolvedValue(testPath)

      const result = await tauriDialogApi.selectFile()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(testPath)
      }
    })

    it('should support file filters', async () => {
      const filters = [{ name: 'Text Files', extensions: ['txt', 'md'] }]
      const testPath = '/home/user/file.txt'
      mockOpen.mockResolvedValue(testPath)

      await tauriDialogApi.selectFile({ filters })

      expect(mockOpen).toHaveBeenCalledWith({
        multiple: false,
        filters,
        title: 'Select File'
      })
    })

    it('should handle errors', async () => {
      mockOpen.mockRejectedValue(new Error('File dialog error'))

      const result = await tauriDialogApi.selectFile()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('DIALOG_ERROR')
      }
    })
  })

  describe('saveFile', () => {
    it('should successfully select save path', async () => {
      const testPath = '/home/user/saved.txt'
      mockSave.mockResolvedValue(testPath)

      const result = await tauriDialogApi.saveFile()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(testPath)
      }
    })

    it('should support file filters for save', async () => {
      const filters = [{ name: 'Documents', extensions: ['doc', 'docx'] }]
      mockSave.mockResolvedValue('/path/to/save.doc')

      await tauriDialogApi.saveFile({ filters })

      expect(mockSave).toHaveBeenCalledWith({
        filters,
        title: 'Save File'
      })
    })

    it('should handle cancellation', async () => {
      mockSave.mockResolvedValue(null)

      const result = await tauriDialogApi.saveFile()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(null)
      }
    })
  })

  describe('confirmClose', () => {
    it('should return true when user confirms', async () => {
      mockConfirm.mockResolvedValue(true)

      const result = await tauriDialogApi.confirmClose('Are you sure?')

      expect(result).toBe(true)
      expect(mockConfirm).toHaveBeenCalledWith('Are you sure?', {
        title: 'Confirm',
        kind: 'warning'
      })
    })

    it('should return false when user cancels', async () => {
      mockConfirm.mockResolvedValue(false)

      const result = await tauriDialogApi.confirmClose('Continue?')

      expect(result).toBe(false)
    })

    it('should handle confirm errors', async () => {
      mockConfirm.mockRejectedValue(new Error('Dialog failed'))

      // confirmClose throws on error
      await expect(tauriDialogApi.confirmClose('Continue?')).rejects.toThrow()
    })

    it('should use the active language for native dialog defaults', async () => {
      await changeUiLanguage('zh-CN')

      await tauriDialogApi.selectDirectory()
      await tauriDialogApi.selectFile()
      await tauriDialogApi.saveFile()
      await tauriDialogApi.confirmClose('继续吗？')
      await tauriDialogApi.showMessage('测试消息')

      expect(mockOpen).toHaveBeenNthCalledWith(1, {
        directory: true,
        multiple: false,
        title: '选择项目文件夹'
      })
      expect(mockOpen).toHaveBeenNthCalledWith(2, {
        multiple: false,
        filters: undefined,
        title: '选择文件'
      })
      expect(mockSave).toHaveBeenCalledWith({
        filters: undefined,
        title: '保存文件'
      })
      expect(mockConfirm).toHaveBeenCalledWith('继续吗？', {
        title: '确认',
        kind: 'warning'
      })
      expect(mockMessage).toHaveBeenCalledWith('测试消息', {
        title: '信息'
      })
    })
  })

  describe('showMessage', () => {
    it('should show message with default title', async () => {
      await tauriDialogApi.showMessage('Test message')

      expect(mockMessage).toHaveBeenCalledWith('Test message', {
        title: 'Info'
      })
    })

    it('should show message with custom title', async () => {
      await tauriDialogApi.showMessage('Test message', 'Custom Title')

      expect(mockMessage).toHaveBeenCalledWith('Test message', {
        title: 'Custom Title'
      })
    })
  })

  describe('interface consistency', () => {
    it('should maintain IpcResult<T> pattern for file operations', () => {
      const methods = [
        tauriDialogApi.selectDirectory,
        tauriDialogApi.selectFile,
        tauriDialogApi.saveFile
      ]

      for (const method of methods) {
        expect(typeof method).toBe('function')
      }
    })

    it('confirmClose and showMessage return different patterns', () => {
      // confirmClose returns Promise<boolean>
      expect(typeof tauriDialogApi.confirmClose).toBe('function')
      // showMessage returns Promise<void>
      expect(typeof tauriDialogApi.showMessage).toBe('function')
    })
  })
})
