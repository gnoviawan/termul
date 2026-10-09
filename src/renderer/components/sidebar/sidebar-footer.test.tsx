import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetCurrentAppVersion, mockConfirm, mockInstallAndRestart, updaterState } = vi.hoisted(
  () => ({
    mockGetCurrentAppVersion: vi.fn(),
    mockConfirm: vi.fn(),
    mockInstallAndRestart: vi.fn(),
    updaterState: { downloaded: false, version: null as string | null, error: null }
  })
)

vi.mock('@/lib/tauri-release-notes', () => ({
  getCurrentAppVersion: mockGetCurrentAppVersion
}))

vi.mock('@/lib/tauri-dialog', () => ({ confirm: mockConfirm }))

vi.mock('@/lib/tauri-safe-update', () => ({ hasActiveTerminalSessions: () => false }))

vi.mock('@/stores/updater-store', () => ({
  useUpdateDownloaded: () => updaterState.downloaded,
  useUpdateVersion: () => updaterState.version,
  updaterStore: {
    getState: () => ({ installAndRestart: mockInstallAndRestart, error: updaterState.error })
  }
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { SidebarFooter } from './sidebar-footer'

describe('SidebarFooter', () => {
  beforeEach(() => {
    mockGetCurrentAppVersion.mockReset()
    mockConfirm.mockReset()
    mockInstallAndRestart.mockReset()
    updaterState.downloaded = false
    updaterState.version = null
  })

  it('shows the version from the app version helper', async () => {
    mockGetCurrentAppVersion.mockResolvedValue('9.8.7')
    render(<SidebarFooter />)

    await waitFor(() => expect(screen.getByText('Termul v9.8.7')).toBeInTheDocument())
    expect(screen.getByTestId('sidebar-footer')).toHaveClass('h-9', 'border-t', 'border-border')
  })

  it('has no update chip when no update is downloaded', async () => {
    mockGetCurrentAppVersion.mockResolvedValue('1.0.0')
    render(<SidebarFooter />)
    await act(async () => {})

    expect(screen.queryByText('Restart to update')).not.toBeInTheDocument()
  })

  it('shows "Restart to update" when an update is downloaded and installs after confirm', async () => {
    mockGetCurrentAppVersion.mockResolvedValue('1.0.0')
    mockConfirm.mockResolvedValue(true)
    updaterState.downloaded = true
    updaterState.version = '1.1.0'
    render(<SidebarFooter />)

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }))

    await waitFor(() => expect(mockInstallAndRestart).toHaveBeenCalledTimes(1))
    expect(mockConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not install when the confirm is declined', async () => {
    mockGetCurrentAppVersion.mockResolvedValue('1.0.0')
    mockConfirm.mockResolvedValue(false)
    updaterState.downloaded = true
    render(<SidebarFooter />)

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }))

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1))
    expect(mockInstallAndRestart).not.toHaveBeenCalled()
  })
})
