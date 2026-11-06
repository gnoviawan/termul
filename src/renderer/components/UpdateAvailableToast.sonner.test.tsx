/**
 * Update toasts against the real sonner Toaster. sonner 1.7.4 applies a
 * dismiss right away but defers every create/update to a setTimeout, so a
 * dismiss that runs before a pending create is lost and the toast stays.
 *
 * N1: the signed "Downloading update" toast must be gone once the update is
 * ready to install. N2: a re-check that replaces the downloaded update must
 * take the stale "ready to install" toast down. N3b: a channel switch must
 * take the previous channel's "update available" toast down.
 */

import { act, render, screen } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

vi.mock('@/lib/tauri-updater-api', () => ({
  isAurUpdateMode: vi.fn(() => false)
}))

vi.mock('@/lib/confirm-install-update', () => ({
  confirmInstallAndRestart: vi.fn()
}))

vi.mock('@/stores/updater-store', async () => {
  const { create } = await import('zustand')
  const { useShallow } = await import('zustand/shallow')
  const store = create(() => ({
    updateAvailable: false,
    version: null as string | null,
    downloaded: false,
    downloadProgress: 0,
    skippedVersion: null as string | null,
    isDownloading: false,
    isManualUpdateMode: false,
    updateChannel: 'nightly'
  }))
  return {
    testStore: store,
    updaterStore: store,
    useUpdaterState: () =>
      store(
        useShallow((s) => ({
          updateAvailable: s.updateAvailable,
          version: s.version,
          downloaded: s.downloaded,
          downloadProgress: s.downloadProgress,
          skippedVersion: s.skippedVersion,
          isDownloading: s.isDownloading,
          isManualUpdateMode: s.isManualUpdateMode
        }))
      ),
    useUpdaterActions: () => ({ skipVersion: vi.fn() }),
    useUpdateVersion: () => store((s) => s.version),
    useUpdateDownloaded: () => store((s) => s.downloaded),
    useIsDownloading: () => store((s) => s.isDownloading),
    useDownloadProgress: () => store((s) => s.downloadProgress)
  }
})

import * as updaterStoreModule from '@/stores/updater-store'
import { useUpdateToast } from './UpdateAvailableToast'

type TestState = {
  updateAvailable: boolean
  version: string | null
  downloaded: boolean
  downloadProgress: number
  skippedVersion: string | null
  isDownloading: boolean
  isManualUpdateMode: boolean
  updateChannel: string
}
const testStore = (
  updaterStoreModule as unknown as {
    testStore: { setState: (s: Partial<TestState>) => void; getInitialState: () => TestState }
  }
).testStore

const VERSION = '0.5.0-nightly.20261028.101.bbbbbbb'
const NEWER = '0.5.0-nightly.20261029.102.ccccccc'

function Harness(): React.JSX.Element {
  useUpdateToast()
  return <Toaster />
}

function setState(state: Partial<TestState>): void {
  act(() => {
    testStore.setState(state)
  })
}

/**
 * Let sonner's deferred creates, dismiss animations and unmounts run. Steps in
 * separate acts, since act holds back the passive effects that schedule
 * sonner's removal timers until it ends.
 */
function settle(steps = 10): void {
  for (let i = 0; i < steps; i++) {
    act(() => {
      vi.advanceTimersByTime(100)
    })
  }
}

describe('useUpdateToast with the real sonner Toaster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    testStore.setState(testStore.getInitialState(), true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('N1: removes the signed download progress toast once the update is ready to install', () => {
    render(<Harness />)
    setState({ updateAvailable: true, version: VERSION, isDownloading: true, downloadProgress: 0 })
    settle()
    setState({ downloadProgress: 40 })
    settle()
    expect(screen.getByText(`Downloading update ${VERSION}...`)).toBeTruthy()

    // The last chunk and the finished download land before sonner's
    // deferred create for that chunk runs.
    setState({ downloadProgress: 99 })
    setState({ downloaded: true, downloadProgress: 100 })
    setState({ isDownloading: false })
    settle()

    expect(screen.getByText('Update ready to install')).toBeTruthy()
    expect(screen.queryByText(`Downloading update ${VERSION}...`)).toBeNull()
  })

  it('N1: removes the progress toast when the download finishes before its first create lands', () => {
    render(<Harness />)
    setState({ updateAvailable: true, version: VERSION, isDownloading: true, downloadProgress: 0 })
    setState({ downloaded: true, downloadProgress: 100 })
    setState({ isDownloading: false })
    settle()

    expect(screen.queryByText(`Downloading update ${VERSION}...`)).toBeNull()
  })

  it('N2: takes the ready toast down when a re-check replaces the downloaded update', () => {
    render(<Harness />)
    setState({ updateAvailable: true, version: VERSION, downloaded: true, downloadProgress: 100 })
    settle()
    expect(screen.getByText('Update ready to install')).toBeTruthy()

    setState({ version: NEWER, downloaded: false, downloadProgress: 0 })
    settle()

    expect(screen.queryByText('Update ready to install')).toBeNull()
  })

  it('N2: keeps the ready toast when a re-check finds the same downloaded version', () => {
    render(<Harness />)
    setState({ updateAvailable: true, version: VERSION, downloaded: true, downloadProgress: 100 })
    settle()

    // The store keeps `downloaded` for the same version (see updater-store).
    setState({ version: VERSION, downloaded: true })
    settle()

    expect(screen.getByText('Update ready to install')).toBeTruthy()
  })

  it('N3b: takes the previous channel update toast down after a channel switch', () => {
    testStore.setState({ isManualUpdateMode: true })
    render(<Harness />)
    setState({ updateAvailable: true, version: VERSION })
    settle()
    expect(screen.getByText('Open download page')).toBeTruthy()

    // setUpdateChannel clears the update before it re-checks the new channel.
    setState({
      updateChannel: 'stable',
      updateAvailable: false,
      version: null,
      isManualUpdateMode: false
    })
    settle()

    expect(screen.queryByText('Open download page')).toBeNull()
    expect(screen.queryByText('Nightly update available')).toBeNull()
  })
})
