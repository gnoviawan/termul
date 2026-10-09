/**
 * L-32: one Esc closes one layer. The REAL DirectoryPicker opens above the REAL
 * NewProjectModal (Browse); the picker takes the Esc in the capture phase and
 * its preventDefault() makes the modal's window handler and panel `onKeyDown`
 * ignore it. A second Esc closes the modal.
 *
 * Mocks mirror NewProjectModal.test.tsx; `@/lib/dialog-api` is the real one, so
 * Browse reaches the picker's registered opener the way it does in the web app.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockListCatalog } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockListCatalog: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
vi.mock('@/lib/log-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log-api')>()),
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/acp-catalog-api', () => ({
  acpCatalogApi: {
    listCatalog: mockListCatalog,
    setCatalogOptIn: vi.fn(),
    isCatalogOptedIn: vi.fn()
  }
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  open: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn()
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), confirm: vi.fn() }))
vi.mock('@/stores/app-settings-store', () => ({ useDefaultProjectColor: () => 'blue' }))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(
    vi.fn(() => ({})),
    { getState: () => ({}) }
  ),
  useProjects: () => []
}))
vi.mock('sonner', () => ({
  toast: { promise: vi.fn(), error: vi.fn(), success: vi.fn(), loading: vi.fn() }
}))

import {
  armMobileOverlayBackStack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { DirectoryPicker } from './DirectoryPicker'
import { NewProjectModal } from './NewProjectModal'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

function Layers({ onClose }: { onClose: () => void }): React.JSX.Element {
  // The inline `onClose` is a new function on every render of this component,
  // so the modal's window Esc listener re-registers when the test re-renders it.
  return (
    <>
      <NewProjectModal isOpen onClose={() => onClose()} onCreateProject={vi.fn()} />
      <DirectoryPicker />
    </>
  )
}

/** Open the picker the way a user does: press Browse, wait for its listing. */
async function openPickerFromBrowse(): Promise<HTMLElement> {
  const browse = await screen.findByRole('button', { name: 'Browse' })
  await act(async () => {
    fireEvent.click(browse)
  })
  await screen.findByText('Select Project Folder')
  await screen.findByText('No subdirectories in this folder')
  browse.focus()
  return browse
}

const pickerIsOpen = (): boolean => screen.queryByText('Select Project Folder') !== null

describe('NewProjectModal with the DirectoryPicker above it: one Esc closes one layer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockListCatalog.mockResolvedValue({
      success: true,
      data: {
        host: { os: 'linux', arch: 'x86_64', runtimes: {} },
        agents: []
      }
    })
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes('/shells')
        ? jsonResponse({
            success: true,
            data: {
              default: { name: 'bash', path: '/bin/bash', displayName: 'Bash' },
              available: [{ name: 'bash', path: '/bin/bash', displayName: 'Bash' }]
            }
          })
        : jsonResponse({ success: true, data: [] })
    )
    window.history.replaceState(null, '', '#/base')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('desktop-web shell (no overlay stack)', () => {
    it('Esc with focus on Browse closes only the picker; the second Esc closes the modal', async () => {
      const onClose = vi.fn()
      render(<Layers onClose={onClose} />)
      const browse = await openPickerFromBrowse()

      fireEvent.keyDown(browse, { key: 'Escape' })

      await waitFor(() => expect(pickerIsOpen()).toBe(false))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.keyDown(browse, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Esc inside the picker closes only the picker; the second Esc closes the modal', async () => {
      const onClose = vi.fn()
      render(<Layers onClose={onClose} />)
      await openPickerFromBrowse()
      const pickerButton = screen.getByRole('button', { name: 'Cancel directory picker' })

      fireEvent.keyDown(pickerButton, { key: 'Escape' })

      await waitFor(() => expect(pickerIsOpen()).toBe(false))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('still takes the first Esc when the modal re-registered its listener after the picker opened', async () => {
      const onClose = vi.fn()
      const { rerender } = render(<Layers onClose={onClose} />)
      const browse = await openPickerFromBrowse()
      // A new inline onClose: the modal's window listener is now registered
      // AFTER the picker's, the order a bubble-only guard cannot survive.
      rerender(<Layers onClose={onClose} />)

      fireEvent.keyDown(browse, { key: 'Escape' })

      await waitFor(() => expect(pickerIsOpen()).toBe(false))
      expect(onClose).not.toHaveBeenCalled()

      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('Esc with the picker closed closes the modal at once (a plain Esc is not swallowed)', async () => {
      const onClose = vi.fn()
      render(<Layers onClose={onClose} />)
      await screen.findByRole('button', { name: 'Browse' })

      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('mobile shell (overlay stack)', () => {
    let cleanup: () => void

    beforeEach(() => {
      cleanup = armMobileOverlayBackStack()
    })

    afterEach(() => {
      cleanup()
    })

    it('the first Esc closes only the picker (the managed Esc fallback skips a prevented Esc), the second the modal', async () => {
      const onClose = vi.fn()
      render(<Layers onClose={onClose} />)
      const browse = await openPickerFromBrowse()
      expect(stackIds()).toHaveLength(2)
      expect(stackIds()[0]).toMatch(/^new-project-modal:/)
      expect(stackIds()[1]).toBe('directory-picker')
      await waitForSentinelDepth(2)

      fireEvent.keyDown(browse, { key: 'Escape' })
      await waitFor(() => expect(pickerIsOpen()).toBe(false))
      // Let the fallback's deferred check run: it must not close the modal.
      await settleOverlayBackStack()

      expect(onClose).not.toHaveBeenCalled()
      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^new-project-modal:/)
      await waitForSentinelDepth(1)

      fireEvent.keyDown(browse, { key: 'Escape' })
      await settleOverlayBackStack()

      // Exactly one call: the modal's own handler took this Esc, so the managed
      // fallback (which would call the registered close again) stood down.
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
    })
  })
})
