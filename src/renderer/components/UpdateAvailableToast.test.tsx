/**
 * Unit tests for UpdateAvailableToast download/install error surfacing.
 *
 * Regression coverage for the silent-failure bug: clicking Download or
 * Restart in the toast must surface store errors via toast.error instead of
 * doing nothing visible. Success paths must NOT show an error toast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

const downloadUpdate = vi.fn(async () => {})
const installAndRestart = vi.fn(async () => {})
let storeError: string | null = null

vi.mock('@/stores/updater-store', () => ({
  updaterStore: {
    getState: () => ({ downloadUpdate, installAndRestart, error: storeError })
  },
  // Hooks are unused by the functions under test but imported by the module.
  useUpdaterState: vi.fn(),
  useUpdaterActions: vi.fn(),
  useUpdateVersion: vi.fn(),
  useUpdateDownloaded: vi.fn(),
  useIsDownloading: vi.fn(),
  useDownloadProgress: vi.fn()
}))

vi.mock('@/lib/tauri-updater-api', () => ({
  isAurUpdateMode: vi.fn(() => false)
}))

import { toast } from 'sonner'
import { showUpdateToast, showUpdateDownloadedToast } from './UpdateAvailableToast'

type ToastAction = { onClick: () => void | Promise<void> }

function lastToastAction(mockFn: ReturnType<typeof vi.fn>): ToastAction {
  const calls = mockFn.mock.calls
  const opts = calls[calls.length - 1][1] as { action: ToastAction }
  return opts.action
}

describe('UpdateAvailableToast error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeError = null
    downloadUpdate.mockResolvedValue(undefined)
    installAndRestart.mockResolvedValue(undefined)
  })

  it('does not show an error toast when download succeeds', async () => {
    showUpdateToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('shows an error toast when download fails (store error set)', async () => {
    storeError = 'signature verification failed'
    showUpdateToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Update download failed',
      expect.objectContaining({ description: 'signature verification failed' })
    )
  })

  it('shows an error toast when install/restart fails (store error set)', async () => {
    storeError = 'relaunch failed'
    showUpdateDownloadedToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(installAndRestart).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'Update install failed',
      expect.objectContaining({ description: 'relaunch failed' })
    )
  })

  it('does not show an error toast when install/restart succeeds', async () => {
    showUpdateDownloadedToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(installAndRestart).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })
})
