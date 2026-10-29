/**
 * The "Downloading update" progress toast must only show for a real
 * download. In manual mode "download" just opens the release page: nothing
 * reports progress, and sonner applies a dismiss that lands before the
 * deferred create as a no-op, so the 0% toast stayed on screen forever.
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

vi.mock('@/lib/tauri-updater-api', () => ({
  isAurUpdateMode: vi.fn(() => false)
}))

vi.mock('@/lib/confirm-install-update', () => ({
  confirmInstallAndRestart: vi.fn()
}))

const VERSION = '0.5.0-nightly.20261028.101.bbbbbbb'
let isManualUpdateMode = false

vi.mock('@/stores/updater-store', () => ({
  updaterStore: {
    getState: () => ({ updateChannel: 'nightly', isManualUpdateMode })
  },
  useUpdaterState: () => ({
    // Already downloading, so the "update available" toast stays out of it.
    updateAvailable: true,
    downloaded: false,
    isDownloading: true,
    skippedVersion: null,
    isManualUpdateMode
  }),
  useUpdaterActions: () => ({ skipVersion: vi.fn() }),
  useUpdateVersion: () => VERSION,
  useUpdateDownloaded: () => false,
  useIsDownloading: () => true,
  useDownloadProgress: () => 0
}))

import { toast } from 'sonner'
import { useUpdateToast } from './UpdateAvailableToast'

describe('useUpdateToast download progress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the progress toast while a signed update downloads', () => {
    isManualUpdateMode = false

    renderHook(() => useUpdateToast())

    expect(toast.loading).toHaveBeenCalledWith(
      `Downloading update ${VERSION}...`,
      expect.objectContaining({ id: `download-progress-${VERSION}` })
    )
  })

  it('shows no progress toast when a manual update only opens the release page', () => {
    isManualUpdateMode = true

    renderHook(() => useUpdateToast())

    expect(toast.loading).not.toHaveBeenCalled()
  })
})
