/**
 * The desktop updater on a non-Tauri desktop shell (the GPUIX client): with a
 * registered host it checks the channel manifest itself, shows the update
 * toast and the What's New popup, and an update only opens the download
 * page. It never downloads or installs. With no host (the browser) the
 * updater stays off.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

import { useUpdateToast } from '@/components/UpdateAvailableToast'
import { useWhatsNew } from '@/hooks/use-whats-new'
import { useUpdaterStore } from '@/stores/updater-store'
import { _resetDesktopHostForTesting, type DesktopHost, registerDesktopHost } from '../desktop-host'
import { _resetReleaseNotesStoreForTesting } from '../tauri-release-notes'
import { _resetUpdateChannelStoreForTesting } from '../tauri-update-channel'
import { _resetUpdaterStateForTesting } from '../tauri-updater-api'
import { _resetVersionSkipStoreForTesting } from '../tauri-version-skip'

const STABLE_MANIFEST =
  'https://github.com/gnoviawan/termul/releases/latest/download/latest-stable.json'
const NIGHTLY_MANIFEST =
  'https://github.com/gnoviawan/termul/releases/download/nightly/latest-nightly.json'

function hostOpening(opened: string[]): DesktopHost {
  return {
    openUrl: async (url) => {
      opened.push(url)
    },
    openPath: async () => {},
    revealItemInDir: async () => {},
    notify: async () => {},
    openFiles: async () => null,
    saveFile: async () => null,
    fileAt: (path) => new File([], path)
  }
}

function serveJson(routes: Record<string, unknown>): string[] {
  const fetched: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      const body = routes[url]
      return body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 })
    })
  )
  return fetched
}

beforeEach(() => {
  localStorage.clear()
  toastSuccess.mockClear()
  vi.stubEnv('VITE_APP_VERSION', '0.4.52')
  _resetDesktopHostForTesting()
  _resetUpdaterStateForTesting()
  _resetReleaseNotesStoreForTesting()
  _resetUpdateChannelStoreForTesting()
  _resetVersionSkipStoreForTesting()
  useUpdaterStore.getState().stopPeriodicChecks()
  useUpdaterStore.setState({
    updateAvailable: false,
    version: null,
    downloaded: false,
    error: null,
    updateChannel: 'stable'
  })
})

afterEach(() => {
  useUpdaterStore.getState().stopPeriodicChecks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('updater with a desktop host', () => {
  it('finds a newer stable release, toasts it, and only opens the download page', async () => {
    const opened: string[] = []
    registerDesktopHost(hostOpening(opened))
    const fetched = serveJson({ [STABLE_MANIFEST]: { version: '0.4.53', notes: 'Fixes' } })

    renderHook(() => useUpdateToast())
    await act(() => useUpdaterStore.getState().initializeUpdater({ autoCheck: true }))

    expect(fetched).toEqual([STABLE_MANIFEST])
    expect(useUpdaterStore.getState()).toMatchObject({
      updateAvailable: true,
      version: '0.4.53',
      error: null
    })
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    const [title, options] = toastSuccess.mock.calls[0]
    expect(title).toBe('Update available')
    expect(options.description).toBe(
      'Version 0.4.53. Open the download page to install it manually.'
    )
    expect(options.action.label).toBe('Open download page')
    expect(options.cancel.label).toBe('Remind me tomorrow')

    await act(() => options.action.onClick())
    expect(opened).toEqual(['https://github.com/gnoviawan/termul/releases/latest'])
    expect(useUpdaterStore.getState()).toMatchObject({ downloaded: false, error: null })
  })

  it('reads the channel the device picked', async () => {
    registerDesktopHost(hostOpening([]))
    localStorage.setItem('updater-preferences.json::updater.updateChannel', '"nightly"')
    const fetched = serveJson({ [NIGHTLY_MANIFEST]: { version: '0.5.0-nightly.20261025.419bce3' } })

    await act(() => useUpdaterStore.getState().initializeUpdater({ autoCheck: true }))

    expect(fetched).toEqual([NIGHTLY_MANIFEST])
    expect(useUpdaterStore.getState()).toMatchObject({
      updateChannel: 'nightly',
      updateAvailable: true,
      version: '0.5.0-nightly.20261025.419bce3'
    })
  })

  it('reports no update when the feed is not newer', async () => {
    registerDesktopHost(hostOpening([]))
    serveJson({ [STABLE_MANIFEST]: { version: '0.4.52' } })

    renderHook(() => useUpdateToast())
    await act(() => useUpdaterStore.getState().initializeUpdater({ autoCheck: true }))

    expect(useUpdaterStore.getState()).toMatchObject({ updateAvailable: false, error: null })
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('opens What’s New once after the app version changed', async () => {
    registerDesktopHost(hostOpening([]))
    localStorage.setItem('whats-new.json::whatsNew.lastSeenVersion', '"0.4.51"')
    serveJson({
      'https://api.github.com/repos/gnoviawan/termul/releases/tags/v0.4.52': {
        body: '## [0.4.52]\n\n- Fixes',
        html_url: 'https://github.com/gnoviawan/termul/releases/tag/v0.4.52'
      }
    })

    const { result } = renderHook(() => useWhatsNew())

    await waitFor(() => expect(result.current.isOpen).toBe(true))
    expect(result.current).toMatchObject({
      version: '0.4.52',
      notes: '## [0.4.52]\n\n- Fixes',
      htmlUrl: 'https://github.com/gnoviawan/termul/releases/tag/v0.4.52'
    })
    expect(localStorage.getItem('whats-new.json::whatsNew.lastSeenVersion')).toBe('"0.4.52"')
  })
})

describe('updater in the browser', () => {
  it('never checks for updates', async () => {
    const fetched = serveJson({ [STABLE_MANIFEST]: { version: '0.4.53' } })

    await act(() => useUpdaterStore.getState().initializeUpdater({ autoCheck: true }))

    expect(fetched).toEqual([])
    expect(useUpdaterStore.getState().updateAvailable).toBe(false)
  })
})
