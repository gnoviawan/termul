import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn()
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  Update: class {}
}))

vi.mock('../tauri-backup-api', () => ({
  BackupErrorCodes: {
    BACKUP_FAILED: 'BACKUP_FAILED',
    RESTORE_FAILED: 'RESTORE_FAILED',
    BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
    DISK_SPACE_ERROR: 'DISK_SPACE_ERROR',
    INVALID_BACKUP: 'INVALID_BACKUP'
  },
  createBackup: vi.fn(),
  setAppVersion: vi.fn()
}))

vi.mock('../tauri-rollback-api', () => ({
  keepPreviousVersion: vi.fn(),
  setCurrentVersion: vi.fn()
}))

import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { createBackup, setAppVersion } from '../tauri-backup-api'
import { keepPreviousVersion, setCurrentVersion } from '../tauri-rollback-api'
import {
  _resetUpdaterStateForTesting,
  checkForUpdates,
  clearPendingUpdate,
  downloadUpdate,
  getAutoUpdateEnabled,
  getUpdaterState,
  installAndRestart,
  isUpdateAvailable,
  mapTauriUpdateToInfo,
  registerUpdateEventHandlers,
  setAutoUpdateEnabled
} from '../tauri-updater-api'

function createMockUpdate(version: string, body?: string, date?: string) {
  return {
    version,
    body,
    date,
    download: vi.fn(),
    install: vi.fn(),
    downloadAndInstall: vi.fn()
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const mockFetch = vi.fn()

describe('tauri-updater-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    _resetUpdaterStateForTesting()
    vi.mocked(getVersion).mockResolvedValue('0.2.3')
    vi.mocked(setAppVersion).mockResolvedValue(undefined)
    vi.mocked(setCurrentVersion).mockResolvedValue(undefined)
    vi.mocked(createBackup).mockResolvedValue({
      success: true,
      data: {
        id: 'backup-1',
        timestamp: '2026-03-01T00:00:00.000Z',
        version: '0.2.3',
        size: 1024,
        fileCount: 4,
        path: '/mock/backups/backup-1'
      }
    } as never)
    vi.mocked(keepPreviousVersion).mockResolvedValue({
      success: true,
      data: {
        version: '0.2.3',
        path: '/mock/versions/v0.2.3',
        size: 2048
      }
    } as never)
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  describe('checkForUpdates', () => {
    it('returns null when no update is available', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true, data: null })

      const result = await checkForUpdates()

      expect(invoke).toHaveBeenCalledWith('updater_check_signed', { channel: 'stable' })
      expect(result).toBeNull()
      const state = await getUpdaterState()
      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.updateAvailable).toBe(false)
        expect(state.data.version).toBeNull()
        expect(state.data.isManualUpdateMode).toBe(false)
      }
    })

    it('returns mapped update info when update exists', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: true,
        data: {
          version: '2.0.0',
          releaseNotes: 'release notes',
          releaseDate: '2026-03-01T00:00:00.000Z'
        }
      })

      const result = await checkForUpdates()

      expect(result).toEqual({
        version: '2.0.0',
        releaseDate: '2026-03-01T00:00:00.000Z',
        releaseNotes: 'release notes',
        isSecurityUpdate: false
      })
    })

    it('throws actionable error details when check fails', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: false,
        error: 'network down',
        code: 'NETWORK_ERROR'
      })

      await expect(checkForUpdates()).rejects.toThrow(
        'Failed to check for updates from https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json: network down'
      )
    })

    it('keeps the signed update when a re-check overlaps an install', async () => {
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          success: true,
          data: {
            version: '2.0.0',
            releaseNotes: 'notes',
            releaseDate: '2026-03-01T00:00:00.000Z'
          }
        })
        .mockResolvedValueOnce({
          success: false,
          error: 'An update install is already in progress',
          code: 'UPDATE_INSTALL_IN_PROGRESS'
        })

      await expect(checkForUpdates()).resolves.toMatchObject({ version: '2.0.0' })
      await expect(checkForUpdates()).resolves.toMatchObject({ version: '2.0.0' })

      const state = await getUpdaterState()
      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.updateAvailable).toBe(true)
        expect(state.data.version).toBe('2.0.0')
      }
    })

    it('does not fall back to a browser release page when the signed manifest is missing', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: false,
        error: 'channel manifest returned HTTP 404',
        code: 'UPDATE_CHECK_FAILED'
      })

      await expect(checkForUpdates()).rejects.toThrow('channel manifest returned HTTP 404')
      expect(mockFetch).not.toHaveBeenCalled()
      const state = await getUpdaterState()
      expect(state.success).toBe(true)
      if (state.success) {
        expect(state.data.updateAvailable).toBe(false)
        expect(state.data.isManualUpdateMode).toBe(false)
      }
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

    it('downloads, installs, and reports progress through the signed command', async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: unknown, args?: unknown) => {
        if (cmd === 'updater_check_signed') {
          return {
            success: true,
            data: {
              version: '2.0.1',
              releaseNotes: 'notes',
              releaseDate: '2026-03-01T00:00:00.000Z'
            }
          }
        }
        if (cmd === 'updater_install_signed') {
          const onEvent = (args as { onEvent?: { onmessage: ((event: unknown) => void) | null } })
            .onEvent
          onEvent?.onmessage?.({ event: 'Started', data: { contentLength: 100 } })
          onEvent?.onmessage?.({ event: 'Progress', data: { chunkLength: 40 } })
          onEvent?.onmessage?.({ event: 'Progress', data: { chunkLength: 60 } })
          onEvent?.onmessage?.({ event: 'Finished' })
          return { success: true, data: undefined }
        }
        return { success: true, data: undefined }
      })
      await checkForUpdates()

      const progressEvents: number[] = []
      const result = await downloadUpdate((progress) => {
        progressEvents.push(progress.percent)
      })

      expect(result).toEqual({ success: true, data: undefined })
      expect(createBackup).toHaveBeenCalledTimes(1)
      expect(keepPreviousVersion).toHaveBeenCalledWith('0.2.3')
      expect(invoke).toHaveBeenCalledWith('updater_install_signed', expect.anything())
      expect(vi.mocked(createBackup).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(invoke).mock.invocationCallOrder.at(-1) ?? 0
      )
      expect(progressEvents[0]).toBe(0)
      expect(progressEvents).toContain(40)
      expect(progressEvents).toContain(100)
    })

    it('returns DOWNLOAD_FAILED when the signed install command fails', async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: unknown) => {
        if (cmd === 'updater_check_signed') {
          return { success: true, data: { version: '2.0.2' } }
        }
        if (cmd === 'updater_install_signed') {
          return { success: false, error: 'download failed', code: 'DOWNLOAD_FAILED' }
        }
        return { success: true, data: undefined }
      })
      await checkForUpdates()

      const result = await downloadUpdate()

      expect(result).toEqual({
        success: false,
        error: 'download failed',
        code: 'DOWNLOAD_FAILED'
      })
    })

    it('returns DISK_SPACE_INSUFFICIENT when backup preparation fails', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: true,
        data: { version: '2.0.3' }
      })
      await checkForUpdates()

      vi.mocked(createBackup).mockResolvedValue({
        success: false,
        error: 'disk full',
        code: 'DISK_SPACE_ERROR'
      } as never)

      const result = await downloadUpdate()

      expect(invoke).not.toHaveBeenCalledWith('updater_install_signed', expect.anything())
      expect(keepPreviousVersion).not.toHaveBeenCalled()
      expect(result).toEqual({
        success: false,
        error: 'disk full',
        code: 'DISK_SPACE_INSUFFICIENT'
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

    it('installs through the signed command after a check', async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: unknown) => {
        if (cmd === 'updater_check_signed') {
          return { success: true, data: { version: '2.1.0' } }
        }
        return { success: true, data: undefined }
      })
      await checkForUpdates()

      const result = await installAndRestart()

      expect(invoke).toHaveBeenCalledWith('updater_install_signed', expect.anything())
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('returns INSTALL_FAILED when the signed install command reports failure', async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: unknown) => {
        if (cmd === 'updater_check_signed') {
          return { success: true, data: { version: '2.1.2' } }
        }
        if (cmd === 'updater_install_signed') {
          return { success: false, error: 'install failed', code: 'INSTALL_FAILED' }
        }
        return { success: true, data: undefined }
      })
      await checkForUpdates()

      const result = await installAndRestart()

      expect(result).toEqual({
        success: false,
        error: 'install failed',
        code: 'INSTALL_FAILED'
      })
    })
  })

  describe('state and helpers', () => {
    it('clearPendingUpdate resets pending and downloaded state', async () => {
      vi.mocked(invoke).mockResolvedValue({
        success: true,
        data: { version: '2.2.0' }
      })
      await checkForUpdates()

      await clearPendingUpdate()
      const state = await getUpdaterState()

      expect(invoke).toHaveBeenCalledWith('updater_clear_pending')
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
      const info = mapTauriUpdateToInfo(
        createMockUpdate('3.0.0', 'notes', '2026-03-01T12:00:00.000Z') as never
      )

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

    it('registerUpdateEventHandlers initializes recovery metadata and returns cleanup', async () => {
      const cleanup = registerUpdateEventHandlers({
        onError: vi.fn()
      })

      await flushPromises()

      expect(getVersion).toHaveBeenCalledTimes(1)
      expect(setAppVersion).toHaveBeenCalledWith('0.2.3')
      expect(setCurrentVersion).toHaveBeenCalledWith('0.2.3')
      expect(typeof cleanup).toBe('function')
      expect(() => cleanup()).not.toThrow()
    })

    it('registerUpdateEventHandlers reports initialization errors via onError', async () => {
      const onError = vi.fn()
      vi.mocked(getVersion).mockRejectedValue(new Error('app unavailable'))

      registerUpdateEventHandlers({ onError })
      await flushPromises()

      expect(onError).toHaveBeenCalledWith(
        'Failed to initialize updater recovery metadata: app unavailable'
      )
    })
  })
})
