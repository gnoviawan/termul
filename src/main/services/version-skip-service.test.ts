import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock persistence service
const mockRead = vi.fn()
const mockWrite = vi.fn()
const mockRemove = vi.fn()

vi.mock('./persistence-service', () => ({
  read: (...args: unknown[]) => mockRead(...args),
  write: (...args: unknown[]) => mockWrite(...args),
  remove: (...args: unknown[]) => mockRemove(...args)
}))

import { skipVersion, getSkippedVersion, clearSkippedVersion, shouldShowUpdate } from './version-skip-service'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('version-skip-service', () => {
  describe('skipVersion', () => {
    it('should persist version with timestamp', async () => {
      mockWrite.mockResolvedValue({ success: true })

      const result = await skipVersion('2.0.0')

      expect(result).toBe(true)
      expect(mockWrite).toHaveBeenCalledWith(
        'settings/skipped-version',
        expect.objectContaining({
          version: '2.0.0',
          skippedAt: expect.any(String)
        })
      )
    })
  })

  describe('getSkippedVersion', () => {
    it('should return skipped version data when exists', async () => {
      const data = { version: '2.0.0', skippedAt: '2026-01-01T00:00:00.000Z' }
      mockRead.mockResolvedValue({ success: true, data })

      const result = await getSkippedVersion()

      expect(result).toEqual(data)
    })

    it('should return null when no version is skipped', async () => {
      mockRead.mockResolvedValue({ success: false })

      const result = await getSkippedVersion()

      expect(result).toBeNull()
    })
  })

  describe('clearSkippedVersion', () => {
    it('should remove the skipped version file', async () => {
      mockRemove.mockResolvedValue({ success: true })

      const result = await clearSkippedVersion()

      expect(result).toBe(true)
      expect(mockRemove).toHaveBeenCalledWith('settings/skipped-version')
    })
  })

  describe('shouldShowUpdate', () => {
    it('should return true when no version is skipped', async () => {
      mockRead.mockResolvedValue({ success: false })

      const result = await shouldShowUpdate('2.0.0')

      expect(result).toBe(true)
    })

    it('should return false when same version is skipped', async () => {
      mockRead.mockResolvedValue({
        success: true,
        data: { version: '2.0.0', skippedAt: '2026-01-01T00:00:00.000Z' }
      })

      const result = await shouldShowUpdate('2.0.0')

      expect(result).toBe(false)
    })

    it('should auto-clear skip and return true when different version is available', async () => {
      mockRead.mockResolvedValue({
        success: true,
        data: { version: '1.5.0', skippedAt: '2026-01-01T00:00:00.000Z' }
      })
      mockRemove.mockResolvedValue({ success: true })

      const result = await shouldShowUpdate('2.0.0')

      expect(result).toBe(true)
      expect(mockRemove).toHaveBeenCalledWith('settings/skipped-version')
    })
  })
})
