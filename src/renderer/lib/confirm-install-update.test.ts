import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConfirm, mockInstallAndRestart, mockToastError, state } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockInstallAndRestart: vi.fn(),
  mockToastError: vi.fn(),
  state: { error: null as string | null, activeTerminals: false, downloaded: true }
}))

vi.mock('@/lib/tauri-dialog', () => ({ confirm: mockConfirm }))
vi.mock('@/lib/tauri-safe-update', () => ({
  hasActiveTerminalSessions: () => state.activeTerminals
}))
vi.mock('@/stores/updater-store', () => ({
  updaterStore: {
    getState: () => ({
      installAndRestart: mockInstallAndRestart,
      error: state.error,
      downloaded: state.downloaded
    })
  }
}))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

import { confirmInstallAndRestart } from './confirm-install-update'

describe('confirmInstallAndRestart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.error = null
    state.activeTerminals = false
    state.downloaded = true
    mockConfirm.mockResolvedValue(true)
    mockInstallAndRestart.mockResolvedValue(undefined)
  })

  it('names the version and installs after confirm', async () => {
    await confirmInstallAndRestart('1.2.3')

    expect(mockConfirm.mock.calls[0][0]).toBe(
      'Termul will install version 1.2.3 and restart now. Continue?'
    )
    expect(mockInstallAndRestart).toHaveBeenCalledTimes(1)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('falls back to "the new version" and warns about running terminals', async () => {
    state.activeTerminals = true
    await confirmInstallAndRestart(null)

    expect(mockConfirm.mock.calls[0][0]).toBe(
      'Termul will install the new version and restart. Your running terminal sessions will be closed. Continue?'
    )
  })

  it('does nothing when the user declines', async () => {
    mockConfirm.mockResolvedValue(false)
    await confirmInstallAndRestart('1.2.3')

    expect(mockInstallAndRestart).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('toasts the store error after a failed install', async () => {
    state.error = 'relaunch failed'
    await confirmInstallAndRestart('1.2.3')

    expect(mockToastError).toHaveBeenCalledWith('Update install failed', {
      description: 'relaunch failed'
    })
  })

  it('reports that the update is no longer ready and ignores a stale error', async () => {
    state.downloaded = false
    state.error = 'relaunch failed'
    await confirmInstallAndRestart('1.2.3')

    expect(mockToastError).toHaveBeenCalledWith('Update install failed', {
      description: 'The update is no longer ready to install.'
    })
    expect(mockToastError).toHaveBeenCalledTimes(1)
  })

  it('toasts a thrown error instead of rejecting', async () => {
    mockInstallAndRestart.mockRejectedValue(new Error('boom'))

    await expect(confirmInstallAndRestart('1.2.3')).resolves.toBeUndefined()
    expect(mockToastError).toHaveBeenCalledWith('Update install failed', { description: 'boom' })
  })
})
