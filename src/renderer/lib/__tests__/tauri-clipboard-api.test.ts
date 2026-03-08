/**
 * Unit tests for tauri-clipboard-api.ts
 * Tests the tauriClipboardApi implementation using Tauri plugin-clipboard-manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @tauri-apps/plugin-clipboard-manager BEFORE importing
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
  writeText: vi.fn(async () => {})
}))

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { tauriClipboardApi } from '../tauri-clipboard-api'

const mockReadText = readText as ReturnType<typeof vi.fn>
const mockWriteText = writeText as ReturnType<typeof vi.fn>

describe('tauriClipboardApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Restore default mocks
    vi.mocked(readText).mockResolvedValue('')
    vi.mocked(writeText).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('readText', () => {
    it('should successfully read text from clipboard', async () => {
      const testText = 'Hello from clipboard!'
      mockReadText.mockResolvedValue(testText)

      const result = await tauriClipboardApi.readText()

      expect(result).toEqual({
        success: true,
        data: testText
      })
    })

    it('should handle errors when reading from clipboard', async () => {
      mockReadText.mockRejectedValue(new Error('Clipboard access denied'))

      const result = await tauriClipboardApi.readText()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('READ_ERROR')
      }
    })

    it('should return empty string when clipboard is empty', async () => {
      mockReadText.mockResolvedValue('')

      const result = await tauriClipboardApi.readText()

      expect(result).toEqual({
        success: true,
        data: ''
      })
    })

    it('should handle multi-line text from clipboard', async () => {
      const multiLineText = 'Line 1\nLine 2\nLine 3'
      mockReadText.mockResolvedValue(multiLineText)

      const result = await tauriClipboardApi.readText()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(multiLineText)
      }
    })
  })

  describe('writeText', () => {
    it('should successfully write text to clipboard', async () => {
      const testText = 'Text to copy'

      const result = await tauriClipboardApi.writeText(testText)

      expect(result.success).toBe(true)
      expect(mockWriteText).toHaveBeenCalledWith(testText)
    })

    it('should handle errors when writing to clipboard', async () => {
      mockWriteText.mockRejectedValue(new Error('Write failed'))

      const result = await tauriClipboardApi.writeText('test')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WRITE_ERROR')
      }
    })

    it('should reject text larger than MAX_CLIPBOARD_SIZE', async () => {
      // Create text larger than 10MB
      const largeText = 'x'.repeat(11 * 1024 * 1024)

      const result = await tauriClipboardApi.writeText(largeText)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('CLIPBOARD_TOO_LARGE')
      }
      expect(mockWriteText).not.toHaveBeenCalled()
    })

    it('should accept text at exactly MAX_CLIPBOARD_SIZE', async () => {
      const maxSizeText = 'x'.repeat(10 * 1024 * 1024)

      const result = await tauriClipboardApi.writeText(maxSizeText)

      expect(result.success).toBe(true)
      expect(mockWriteText).toHaveBeenCalledWith(maxSizeText)
    })

    it('should handle empty string', async () => {
      const result = await tauriClipboardApi.writeText('')

      expect(result.success).toBe(true)
      expect(mockWriteText).toHaveBeenCalledWith('')
    })

    it('should handle special characters', async () => {
      const specialText = '🎉\n\t\r\n中文'

      const result = await tauriClipboardApi.writeText(specialText)

      expect(result.success).toBe(true)
      expect(mockWriteText).toHaveBeenCalledWith(specialText)
    })
  })

  describe('interface consistency', () => {
    it('should maintain consistent IpcResult<T> pattern', async () => {
      const testText = 'test'

      const readResult = await tauriClipboardApi.readText()
      expect(typeof readResult.success).toBe('boolean')

      const writeResult = await tauriClipboardApi.writeText(testText)
      expect(typeof writeResult.success).toBe('boolean')
    })
  })
})
