import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WindowState } from '../../shared/types/persistence.types'

// Mock electron screen module
const mockDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1040 }
}

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: vi.fn(() => mockDisplay),
    getAllDisplays: vi.fn(() => [mockDisplay])
  },
  BrowserWindow: vi.fn()
}))

// Mock persistence service
vi.mock('./persistence-service', () => ({
  read: vi.fn(),
  write: vi.fn(),
  writeDebounced: vi.fn()
}))

import { getDefaultWindowState, isPositionOnScreen } from './window-state'
import * as persistenceService from './persistence-service'

describe('window-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDefaultWindowState', () => {
    it('should return centered default dimensions', () => {
      const state = getDefaultWindowState()

      expect(state.width).toBe(1200)
      expect(state.height).toBe(800)
      expect(state.isMaximized).toBe(false)
      // Should be centered: (1920 - 1200) / 2 = 360, (1040 - 800) / 2 = 120
      expect(state.x).toBe(360)
      expect(state.y).toBe(120)
    })
  })

  describe('isPositionOnScreen', () => {
    it('should return true for position fully on screen', () => {
      const state: WindowState = {
        x: 100,
        y: 100,
        width: 800,
        height: 600,
        isMaximized: false
      }

      expect(isPositionOnScreen(state)).toBe(true)
    })

    it('should return true for position partially on screen (100+ pixels visible)', () => {
      const state: WindowState = {
        x: -700, // 800 - 700 = 100 pixels visible
        y: 100,
        width: 800,
        height: 600,
        isMaximized: false
      }

      expect(isPositionOnScreen(state)).toBe(true)
    })

    it('should return false for position completely off screen', () => {
      const state: WindowState = {
        x: -2000,
        y: -2000,
        width: 800,
        height: 600,
        isMaximized: false
      }

      expect(isPositionOnScreen(state)).toBe(false)
    })

    it('should return false for position with less than 100 pixels visible', () => {
      const state: WindowState = {
        x: -750, // Only 50 pixels would be visible
        y: 100,
        width: 800,
        height: 600,
        isMaximized: false
      }

      expect(isPositionOnScreen(state)).toBe(false)
    })

    it('should return false for window positioned past right edge', () => {
      const state: WindowState = {
        x: 1900, // Only 20 pixels on screen (1920 - 1900)
        y: 100,
        width: 800,
        height: 600,
        isMaximized: false
      }

      expect(isPositionOnScreen(state)).toBe(false)
    })
  })

  describe('loadWindowState', () => {
    it('should return persisted state when valid and on screen', async () => {
      const { loadWindowState } = await import('./window-state')

      const persistedState: WindowState = {
        x: 200,
        y: 200,
        width: 1000,
        height: 700,
        isMaximized: false
      }

      vi.mocked(persistenceService.read).mockResolvedValue({
        success: true,
        data: persistedState
      })

      const result = await loadWindowState()

      expect(result).toEqual(persistedState)
    })

    it('should return default state when no persisted data exists', async () => {
      const { loadWindowState } = await import('./window-state')

      vi.mocked(persistenceService.read).mockResolvedValue({
        success: false,
        error: 'File not found',
        code: 'FILE_NOT_FOUND'
      })

      const result = await loadWindowState()

      expect(result.width).toBe(1200)
      expect(result.height).toBe(800)
      expect(result.isMaximized).toBe(false)
    })

    it('should preserve size but reset position when off screen', async () => {
      const { loadWindowState } = await import('./window-state')

      const offScreenState: WindowState = {
        x: -5000,
        y: -5000,
        width: 1000,
        height: 700,
        isMaximized: true
      }

      vi.mocked(persistenceService.read).mockResolvedValue({
        success: true,
        data: offScreenState
      })

      const result = await loadWindowState()

      // Position should be reset to default center
      expect(result.x).toBe(360) // (1920 - 1200) / 2
      expect(result.y).toBe(120) // (1040 - 800) / 2
      // Size and maximized state should be preserved
      expect(result.width).toBe(1000)
      expect(result.height).toBe(700)
      expect(result.isMaximized).toBe(true)
    })
  })
})
