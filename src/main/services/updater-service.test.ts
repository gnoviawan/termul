import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The UpdaterService uses createRequire(import.meta.url) to load electron-updater
// which doesn't work in jsdom. We need to mock node:module before the service loads.
const mockAutoUpdater = {
  setFeedURL: vi.fn(),
  on: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  autoDownload: false,
  autoInstallOnAppQuit: false
}

// Mock createRequire so it returns our mock electron-updater
vi.mock('node:module', () => {
  const mockCreateRequire = () => (moduleName: string) => {
    if (moduleName === 'electron-updater') {
      return { autoUpdater: mockAutoUpdater }
    }
    throw new Error(`Cannot find module '${moduleName}'`)
  }
  // node:module needs a default export (the Module class)
  const Module = { createRequire: mockCreateRequire }
  return { default: Module, createRequire: mockCreateRequire }
})

// Mock version-skip-service
const mockGetSkippedVersion = vi.fn()
const mockPersistSkipVersion = vi.fn()
const mockShouldShowUpdate = vi.fn()

vi.mock('./version-skip-service', () => ({
  skipVersion: (...args: unknown[]) => mockPersistSkipVersion(...args),
  getSkippedVersion: () => mockGetSkippedVersion(),
  shouldShowUpdate: (...args: unknown[]) => mockShouldShowUpdate(...args)
}))

// Mock persistence-service
vi.mock('./persistence-service', () => ({
  read: vi.fn().mockResolvedValue({ success: false }),
  write: vi.fn().mockResolvedValue({ success: true })
}))

import { getUpdaterService, resetUpdaterService } from './updater-service'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mockGetSkippedVersion.mockResolvedValue(null)
  mockShouldShowUpdate.mockResolvedValue(true)
  mockPersistSkipVersion.mockResolvedValue(true)
  resetUpdaterService()
})

afterEach(() => {
  resetUpdaterService()
  vi.useRealTimers()
})

describe('UpdaterService', () => {
  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = getUpdaterService()
      const b = getUpdaterService()
      expect(a).toBe(b)
    })
  })

  describe('checkForUpdates', () => {
    it('should return error if not initialized', async () => {
      const service = getUpdaterService()

      const result = await service.checkForUpdates()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('not initialized')
      }
    })

    it('should call autoUpdater.checkForUpdates when initialized', async () => {
      const service = getUpdaterService()
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      mockAutoUpdater.checkForUpdates.mockResolvedValue({
        updateInfo: { version: '2.0.0' }
      })

      await service.initialize(mockWindow as any)
      const result = await service.checkForUpdates()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data?.version).toBe('2.0.0')
      }
    })

    it('should reject concurrent checks with ALREADY_RUNNING', async () => {
      const service = getUpdaterService()
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }

      // Make checkForUpdates hang
      let resolveCheck: (v: unknown) => void
      mockAutoUpdater.checkForUpdates.mockReturnValue(
        new Promise((resolve) => {
          resolveCheck = resolve
        })
      )

      await service.initialize(mockWindow as any)

      // Start first check (will hang)
      const firstCheck = service.checkForUpdates()

      // Second check should fail immediately
      const secondResult = await service.checkForUpdates()
      expect(secondResult.success).toBe(false)
      if (!secondResult.success) {
        expect(secondResult.code).toBe('ALREADY_RUNNING')
      }

      // Clean up the first check
      resolveCheck!({ updateInfo: { version: '2.0.0' } })
      await firstCheck
    })
  })

  describe('skipVersion', () => {
    it('should persist skip via version-skip-service', async () => {
      const service = getUpdaterService()

      const result = await service.skipVersion('2.0.0')

      expect(result.success).toBe(true)
      expect(mockPersistSkipVersion).toHaveBeenCalledWith('2.0.0')
    })
  })

  describe('getState', () => {
    it('should return current state', () => {
      const service = getUpdaterService()
      const state = service.getState()

      expect(state.state).toBe('idle')
      expect(state.updateInfo).toBeNull()
      expect(state.error).toBeNull()
    })
  })

  describe('initialization', () => {
    it('should load skipped version on initialize', async () => {
      mockGetSkippedVersion.mockResolvedValue({
        version: '1.5.0',
        skippedAt: '2026-01-01T00:00:00.000Z'
      })

      const service = getUpdaterService()
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }

      await service.initialize(mockWindow as any)

      expect(mockGetSkippedVersion).toHaveBeenCalled()
    })

    it('should not re-initialize if already initialized', async () => {
      const service = getUpdaterService()
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }

      await service.initialize(mockWindow as any)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await service.initialize(mockWindow as any)

      expect(warnSpy).toHaveBeenCalledWith('UpdaterService already initialized')
      warnSpy.mockRestore()
    })
  })
})
