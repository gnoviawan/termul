import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '@/lib/tauri-updater-api'

const downloadUpdate = vi.fn(async () => {})
let storeError: string | null = null
let updateChannel: UpdateChannel = 'stable'
let isDownloading = false
let downloadProgress = 0
let updateAvailable = true
let version: string | null = '1.2.3'

vi.mock('@/stores/updater-store', () => ({
  updaterStore: {
    getState: () => ({ error: storeError })
  },
  useUpdaterState: () => ({
    updateAvailable,
    isDownloading,
    error: storeError,
    downloadProgress
  }),
  useUpdateVersion: () => version,
  useUpdateChannel: () => updateChannel,
  useUpdaterActions: () => ({ downloadUpdate })
}))

const isAur = vi.fn(() => false)
vi.mock('@/lib/tauri-updater-api', () => ({
  isAurUpdateMode: () => isAur()
}))

const isDesktop = vi.fn(() => true)
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => isDesktop()
}))

const hasActiveTerminalSessions = vi.fn(() => false)
vi.mock('@/lib/tauri-safe-update', () => ({
  hasActiveTerminalSessions: () => hasActiveTerminalSessions()
}))

import { UpdateAvailableDialog } from './UpdateAvailableDialog'

describe('UpdateAvailableDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    storeError = null
    updateChannel = 'stable'
    isDownloading = false
    downloadProgress = 0
    updateAvailable = true
    version = '1.2.3'
    isAur.mockReturnValue(false)
    isDesktop.mockReturnValue(true)
    hasActiveTerminalSessions.mockReturnValue(false)
    downloadUpdate.mockResolvedValue(undefined)
  })

  it('shows the update on any screen with Update and Later', () => {
    render(<UpdateAvailableDialog />)

    expect(screen.getByRole('dialog', { name: 'New update available' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Stable 1.2.3 is ready. Termul will download the update, install it, and restart.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip this version' })).not.toBeInTheDocument()
    expect(screen.queryByText(/download page/i)).not.toBeInTheDocument()
  })

  it('starts the signed update when no terminal is open', () => {
    render(<UpdateAvailableDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('dialog', { name: 'Close terminals and update?' })
    ).not.toBeInTheDocument()
  })

  it('asks once before update when a terminal is open', () => {
    hasActiveTerminalSessions.mockReturnValue(true)
    render(<UpdateAvailableDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Close terminals and update?' })).toBeInTheDocument()
    expect(screen.getByText(/running terminal sessions/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not update when the terminal confirm is cancelled', () => {
    hasActiveTerminalSessions.mockReturnValue(true)
    render(<UpdateAvailableDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(downloadUpdate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('hides until tomorrow when the user chooses Later', () => {
    render(<UpdateAvailableDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(localStorage.getItem('update-reminder-timestamp')).toBeTruthy()
  })

  it('names the Insider channel', () => {
    updateChannel = 'insider'
    version = '0.5.0-rc.1'
    render(<UpdateAvailableDialog />)

    expect(screen.getByText(/Insider 0\.5\.0-rc\.1 is ready/)).toBeInTheDocument()
  })

  it('names the Nightly channel', () => {
    updateChannel = 'nightly'
    version = '0.0.0-nightly.20261005.abc'
    render(<UpdateAvailableDialog />)

    expect(screen.getByText(/Nightly 0\.0\.0-nightly\.20261005\.abc is ready/)).toBeInTheDocument()
  })

  it('shows the AUR command and no Update button', () => {
    isAur.mockReturnValue(true)
    render(<UpdateAvailableDialog />)

    expect(screen.getByText('yay -S termul-manager')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
  })

  it('shows download progress while the update runs', () => {
    isDownloading = true
    downloadProgress = 42
    render(<UpdateAvailableDialog />)

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText('42% complete')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument()
  })

  it('stays hidden on the web client', () => {
    isDesktop.mockReturnValue(false)
    render(<UpdateAvailableDialog />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
