import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the updater service
const mockCheckForUpdates = vi.fn()
const mockDownloadUpdate = vi.fn()
const mockInstallAndRestart = vi.fn()
const mockSkipVersion = vi.fn()
const mockGetState = vi.fn()

vi.mock('../services/updater-service', () => ({
  getUpdaterService: () => ({
    checkForUpdates: mockCheckForUpdates,
    downloadUpdate: mockDownloadUpdate,
    installAndRestart: mockInstallAndRestart,
    skipVersion: mockSkipVersion,
    getState: mockGetState,
    initialize: vi.fn()
  }),
  UpdaterService: {
    getInstance: vi.fn(),
    resetInstance: vi.fn()
  }
}))

vi.mock('../services/persistence-service', () => ({
  read: vi.fn().mockResolvedValue({ success: true, data: true }),
  write: vi.fn().mockResolvedValue({ success: true })
}))

import { initRegisterUpdaterIpc, unregisterUpdaterIpc } from './updater.ipc'

// Capture registered handlers
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
const registeredHandlers = new Map<string, IpcHandler>()

beforeEach(() => {
  vi.clearAllMocks()
  registeredHandlers.clear()

  // Capture ipcMain.handle calls
  const { ipcMain } = globalThis.mockElectron
  ipcMain.handle.mockImplementation((channel: string, handler: IpcHandler) => {
    registeredHandlers.set(channel, handler)
  })
  ipcMain.removeHandler.mockImplementation((channel: string) => {
    registeredHandlers.delete(channel)
  })
})

afterEach(() => {
  unregisterUpdaterIpc()
})

describe('updater.ipc', () => {
  describe('initRegisterUpdaterIpc', () => {
    it('should register all updater IPC handlers', () => {
      initRegisterUpdaterIpc()

      const expectedChannels = [
        'updater:checkForUpdates',
        'updater:downloadUpdate',
        'updater:installAndRestart',
        'updater:skipVersion',
        'updater:getState',
        'updater:setAutoUpdateEnabled',
        'updater:getAutoUpdateEnabled'
      ]

      for (const channel of expectedChannels) {
        expect(registeredHandlers.has(channel)).toBe(true)
      }
    })

    it('should not register handlers twice', () => {
      initRegisterUpdaterIpc()
      initRegisterUpdaterIpc()

      // ipcMain.handle should only be called once per channel
      const channelCounts: Record<string, number> = {}
      for (const call of globalThis.mockElectron.ipcMain.handle.mock.calls) {
        const channel = call[0] as string
        channelCounts[channel] = (channelCounts[channel] || 0) + 1
      }

      for (const channel of Object.keys(channelCounts)) {
        expect(channelCounts[channel]).toBe(1)
      }
    })
  })

  describe('checkForUpdates handler', () => {
    it('should return shared update info on success', async () => {
      initRegisterUpdaterIpc()

      mockCheckForUpdates.mockResolvedValue({
        success: true,
        data: {
          version: '2.0.0',
          releaseDate: '2026-01-01T00:00:00.000Z',
          releaseNotes: 'Bug fixes'
        }
      })

      const handler = registeredHandlers.get('updater:checkForUpdates')!
      const result = await handler()

      expect(result.success).toBe(true)
      expect(result.data).toEqual(
        expect.objectContaining({
          version: '2.0.0'
        })
      )
    })

    it('should map error codes correctly on failure', async () => {
      initRegisterUpdaterIpc()

      mockCheckForUpdates.mockResolvedValue({
        success: false,
        error: 'Network error',
        code: 'NETWORK_ERROR'
      })

      const handler = registeredHandlers.get('updater:checkForUpdates')!
      const result = await handler()

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('getState handler', () => {
    it('should return shared update state', async () => {
      initRegisterUpdaterIpc()

      mockGetState.mockReturnValue({
        state: 'available',
        updateInfo: { version: '2.0.0', releaseDate: '2026-01-01' },
        downloadProgress: null,
        error: null,
        skippedVersion: null
      })

      const handler = registeredHandlers.get('updater:getState')!
      const result = await handler()

      expect(result.success).toBe(true)
      expect(result.data.updateAvailable).toBe(true)
      expect(result.data.version).toBe('2.0.0')
    })
  })

  describe('unregisterUpdaterIpc', () => {
    it('should remove all handlers', () => {
      initRegisterUpdaterIpc()
      unregisterUpdaterIpc()

      const expectedChannels = [
        'updater:checkForUpdates',
        'updater:downloadUpdate',
        'updater:installAndRestart',
        'updater:skipVersion',
        'updater:getState',
        'updater:setAutoUpdateEnabled',
        'updater:getAutoUpdateEnabled'
      ]

      for (const channel of expectedChannels) {
        expect(globalThis.mockElectron.ipcMain.removeHandler).toHaveBeenCalledWith(channel)
      }
    })
  })
})
