/**
 * Unit tests for UpdateAvailableToast download/install error surfacing.
 *
 * Regression coverage for the silent-failure bug: clicking Download or
 * Restart in the toast must surface store errors via toast.error instead of
 * doing nothing visible. Success paths must NOT show an error toast.
 */

import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '@/lib/tauri-updater-api'

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
let storeChannel: UpdateChannel = 'stable'

vi.mock('@/stores/updater-store', () => ({
  updaterStore: {
    // `showUpdateToast` reads `updateChannel` from the store to pick the
    // channel prefix + manual-download action label. Without `updateChannel`
    // here it reads `undefined` and produces "A new undefined build...".
    getState: () => ({
      downloadUpdate,
      installAndRestart,
      error: storeError,
      updateChannel: storeChannel
    })
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

const confirmMock = vi.fn(async (_message: string, _options?: unknown) => true)
vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: (message: string, options?: unknown) => confirmMock(message, options)
}))

const hasActiveTerminalSessions = vi.fn(() => false)
vi.mock('@/lib/tauri-safe-update', () => ({
  hasActiveTerminalSessions: () => hasActiveTerminalSessions()
}))

import { toast } from 'sonner'
import { showUpdateDownloadedToast, showUpdateToast } from './UpdateAvailableToast'

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
    storeChannel = 'stable'
    downloadUpdate.mockResolvedValue(undefined)
    installAndRestart.mockResolvedValue(undefined)
    confirmMock.mockResolvedValue(true)
    hasActiveTerminalSessions.mockReturnValue(false)
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

    expect(confirmMock).toHaveBeenCalledTimes(1)
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

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(installAndRestart).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('does not install when the user cancels the confirmation dialog', async () => {
    confirmMock.mockResolvedValue(false)
    showUpdateDownloadedToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(installAndRestart).not.toHaveBeenCalled()
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })

  it('warns about active terminal sessions in the confirmation dialog', async () => {
    hasActiveTerminalSessions.mockReturnValue(true)
    showUpdateDownloadedToast('0.3.8')
    const action = lastToastAction(vi.mocked(toast.success))

    await action.onClick()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    const message = confirmMock.mock.calls[0][0]
    expect(message).toContain('terminal sessions')
  })
})

describe('UpdateAvailableToast channel-aware labeling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeChannel = 'stable'
    storeError = null
  })

  it('uses the stable title, description, and Download action label by default', () => {
    showUpdateToast('0.4.8')
    const calls = vi.mocked(toast.success).mock.calls
    const [title, opts] = calls[calls.length - 1] as [
      string,
      { description: string; action: { label: ReactElement } }
    ]
    expect(title).toBe('Update available: version 0.4.8')
    expect(opts.description).toBe('A new version is available for download.')
    expect(renderToStaticMarkup(opts.action.label)).toContain('Download')
    // The stable action label must NOT show the manual-download CTA.
    expect(renderToStaticMarkup(opts.action.label)).not.toContain('Open Download Page')
  })

  it('prefixes the title with "Insider" and uses the manual-download action label for insider', () => {
    storeChannel = 'insider'
    showUpdateToast('0.5.0-rc.1')
    const calls = vi.mocked(toast.success).mock.calls
    const [title, opts] = calls[calls.length - 1] as [
      string,
      { description: string; action: { label: ReactElement } }
    ]
    expect(title).toBe('Insider Update available: version 0.5.0-rc.1')
    expect(opts.description).toBe(
      'A new insider build is available. Open the download page to install it manually.'
    )
    expect(renderToStaticMarkup(opts.action.label)).toContain('Open Download Page')
  })

  it('prefixes the title with "Nightly" for the nightly channel', () => {
    storeChannel = 'nightly'
    showUpdateToast('0.0.0-nightly.20260808.abc')
    const calls = vi.mocked(toast.success).mock.calls
    const [title, opts] = calls[calls.length - 1] as [string, { description: string }]
    expect(title).toBe('Nightly Update available: version 0.0.0-nightly.20260808.abc')
    expect(opts.description).toBe(
      'A new nightly build is available. Open the download page to install it manually.'
    )
  })
})
