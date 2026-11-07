import { UpdaterErrorCodes } from '@shared/types/updater.types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.4.60')
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(), Update: class {} }))
vi.mock('../log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('../tauri-backup-api', () => ({
  BackupErrorCodes: {},
  createBackup: vi.fn(),
  setAppVersion: vi.fn()
}))
vi.mock('../tauri-rollback-api', () => ({
  keepPreviousVersion: vi.fn(),
  setCurrentVersion: vi.fn()
}))

type UpdaterApi = typeof import('../tauri-updater-api')
let api: UpdaterApi

beforeAll(async () => {
  vi.stubEnv('VITE_TERMUL_UPDATE_MODE', 'aur')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ tag_name: 'v0.5.0', html_url: 'https://example.test/r' }))
  )
  api = await import('../tauri-updater-api')
})

afterAll(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('tauri-updater-api in AUR mode', () => {
  it('tells the user to update the troupe AUR package instead of downloading', async () => {
    expect(api.isAurUpdateMode()).toBe(true)
    expect((await api.checkForUpdates())?.version).toBe('0.5.0')

    expect(await api.downloadUpdate()).toEqual({
      success: false,
      error: 'AUR build cannot self-update. Update with: yay -S troupe',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    })
  })

  it('tells the user to update the troupe AUR package instead of installing', async () => {
    expect(await api.installAndRestart()).toEqual({
      success: false,
      error: 'AUR build cannot self-install updates. Update with: yay -S troupe',
      code: UpdaterErrorCodes.UPDATE_NOT_AVAILABLE
    })
  })
})
