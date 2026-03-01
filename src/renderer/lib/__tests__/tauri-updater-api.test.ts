import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
  Update: class {}
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn()
}))

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import {
  checkForUpdates,
  clearPendingUpdate,
  downloadUpdate,
  installAndRestart,
  getUpdaterState,
  setAutoUpdateEnabled,
  getAutoUpdateEnabled,
  mapTauriUpdateToInfo,
  isUpdateAvailable,
  registerUpdateEventHandlers,
  _resetUpdaterStateForTesting
} from '../tauri-updater-api'

function createMockUpdate(version: string, body?: string, date?: string) {
  return {
    version,
    body,
    date,
    downloadAndInstall: vi.fn()
  }
}

describe('tauri-updater-api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetUpdaterStateForTesting()
  })

  describe('checkForUpdates', () => {
    it('returns null when no update is available', async () => {
      vi.mocked(check).mockResolvedValue(null)

      const result = await checkForUpdates()

      expect(result).toBeNull()
      const state = await getUpdaterState()
      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.updateAvailable).toBe(false)
        expect(state.data.version).toBeNull()
      }
    })

    it('returns mapped update info when update exists', async () => {
      const update = createMockUpdate('2.0.0', 'release notes', '2026-03-01T00:00:00.000Z')
      vi.mocked(check).mockResolvedValue(update as never)

      const result = await checkForUpdates()

      expect(result).toEqual({
        version: '2.0.0',
        releaseDate: '2026-03-01T00:00:00.000Z',
        releaseNotes: 'release notes',
        isSecurityUpdate: false
      })
    })

    it('throws standardized error when check fails', async () => {
      vi.mocked(check).mockRejectedValue(new Error('network down'))

      await expect(checkForUpdates()).rejects.toThrow('Failed to check for updates')
    })
  })

  describe('downloadUpdate', () => {
    it('returns UPDATE_NOT_AVAILABLE when no pending update exists', async () => {
      const result = await downloadUpdate()

      expect(result).toEqual({
        success: false,
        error: 'No update available to download',
        code: 'UPDATE_NOT_AVAILABLE'
      })
    })

    it('reports progress and marks downloaded version on success', async () => {
      const update = createMockUpdate('2.0.1', 'notes')
      vi.mocked(check).mockResolvedValue(update as never)
      await checkForUpdates()

      vi.mocked(update.downloadAndInstall).mockImplementation(
        async (onEvent?: (event: DownloadEvent) => void) => {
          onEvent?.({ event: 'Started', data: { contentLength: 100 } })
          onEvent?.({ event: 'Progress', data: { chunkLength: 40 } })
          onEvent?.({ event: 'Progress', data: { chunkLength: 60 } })
          onEvent?.({ event: 'Finished' })
        }
      )

      const progressEvents: number[] = []
      const result = await downloadUpdate((progress) => {
        progressEvents.push(progress.percent)
      })

      expect(result).toEqual({ success: true, data: undefined })
      expect(progressEvents[0]).toBe(0)
      expect(progressEvents).toContain(40)
      expect(progressEvents).toContain(100)

      const state = await getUpdaterState()
      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.downloaded).toBe(true)
        expect(state.data.version).toBe('2.0.1')
      }
    })

    it('returns DOWNLOAD_FAILED when download throws', async () => {
      const update = createMockUpdate('2.0.2')
      vi.mocked(check).mockResolvedValue(update as never)
      await checkForUpdates()

      vi.mocked(update.downloadAndInstall).mockRejectedValue(new Error('download failed'))

      const result = await downloadUpdate()

      expect(result).toEqual({
        success: false,
        error: 'download failed',
        code: 'DOWNLOAD_FAILED'
      })
    })
  })

  describe('installAndRestart', () => {
    it('returns UPDATE_NOT_AVAILABLE when update not downloaded', async () => {
      const result = await installAndRestart()

      expect(result).toEqual({
        success: false,
        error: 'No downloaded update ready to install',
        code: 'UPDATE_NOT_AVAILABLE'
      })
    })

    it('calls relaunch when update has been downloaded', async () => {
      const update = createMockUpdate('2.1.0')
      vi.mocked(check).mockResolvedValue(update as never)
      await checkForUpdates()

      vi.mocked(update.downloadAndInstall).mockImplementation(async () => {})
      await downloadUpdate()

      vi.mocked(relaunch).mockResolvedValue(undefined)
      const result = await installAndRestart()

      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('returns INSTALL_FAILED when relaunch throws', async () => {
      const update = createMockUpdate('2.1.1')
      vi.mocked(check).mockResolvedValue(update as never)
      await checkForUpdates()

      vi.mocked(update.downloadAndInstall).mockImplementation(async () => {})
      await downloadUpdate()

      vi.mocked(relaunch).mockRejectedValue(new Error('relaunch failed'))
      const result = await installAndRestart()

      expect(result).toEqual({
        success: false,
        error: 'relaunch failed',
        code: 'INSTALL_FAILED'
      })
    })
  })

  describe('state and helpers', () => {
    it('clearPendingUpdate resets pending and downloaded state', async () => {
      const update = createMockUpdate('2.2.0')
      vi.mocked(check).mockResolvedValue(update as never)
      await checkForUpdates()

      await clearPendingUpdate()
      const state = await getUpdaterState()

      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.updateAvailable).toBe(false)
        expect(state.data.downloaded).toBe(false)
        expect(state.data.version).toBeNull()
      }
    })

    it('set/get autoUpdateEnabled round-trips value', async () => {
      await setAutoUpdateEnabled(false)
      const disabled = await getAutoUpdateEnabled()
      expect(disabled).toEqual({ success: true, data: false })

      await setAutoUpdateEnabled(true)
      const enabled = await getAutoUpdateEnabled()
      expect(enabled).toEqual({ success: true, data: true })
    })

    it('mapTauriUpdateToInfo maps body/date correctly', () => {
      const info = mapTauriUpdateToInfo(createMockUpdate('3.0.0', 'notes', '2026-03-01T12:00:00.000Z') as never)

      expect(info).toEqual({
        version: '3.0.0',
        releaseDate: '2026-03-01T12:00:00.000Z',
        releaseNotes: 'notes',
        isSecurityUpdate: false
      })
    })

    it('isUpdateAvailable returns boolean guard semantics', () => {
      expect(isUpdateAvailable(null)).toBe(false)
      expect(isUpdateAvailable(createMockUpdate('1.0.0') as never)).toBe(true)
    })

    it('registerUpdateEventHandlers returns cleanup function', () => {
      const cleanup = registerUpdateEventHandlers({
        onError: vi.fn()
      })

      expect(typeof cleanup).toBe('function')
      expect(() => cleanup()).not.toThrow()
    })
  })
})
