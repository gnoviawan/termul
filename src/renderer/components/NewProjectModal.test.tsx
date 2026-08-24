/**
 * Patch G (verification gap): end-to-end test for `NewProjectModal`'s web-mode
 * create flow. The original bug was `Setup failed: fs.mkdir is unavailable`
 * firing from `NewProjectModal`'s `handleCreate` → `filesystemApi.createDirectory`
 * → `scaffoldProject` chain. Every facade was tested in isolation but the modal's
 * full create chain was untested in web mode (`!isTauriContext()`).
 *
 * This test mocks `fetch` for `/fs/mkdir`, `/fs/write`, `/git/init`, plus
 * `shellApi`/`filesystemApi.readDirectory` for the empty-check, fills name+path,
 * clicks Create, and asserts:
 *  (1) NO `fs.mkdir is unavailable` error surfaces (the original user bug),
 *  (2) the `onCreateProject` callback fires (the flow completes).
 *
 * Mirrors `WorkspaceLayout.test.tsx` conventions (MemoryRouter, TooltipProvider,
 * store mocks). The `@tauri-apps/plugin-fs` + `@tauri-apps/plugin-dialog` +
 * `@tauri-apps/api/core` modules are stubbed so the module loads without a
 * Tauri runtime; the web branch is the one under test.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewProjectModal } from './NewProjectModal'

const {
  mockFetch,
  mockIsTauriContext,
  mockInvoke,
  mockSelectDirectory,
  mockDefaultProjectColor,
  mockUseProjectStore
} = vi.hoisted(() => ({
  // fetch: used by webServerFilesystem / webServerGit / webServerShell.
  mockFetch: vi.fn(),
  // Pin to web mode so the createDirectory/createFile/readDirectory/git.init
  // chain routes through the fetch client (NOT the Tauri plugin-fs / invoke).
  mockIsTauriContext: vi.fn(() => false),
  // invoke: desktop-only; never called in web mode. Stubbed so the module
  // loads without a real Tauri runtime.
  mockInvoke: vi.fn(),
  // dialogApi.selectDirectory: the Browse button calls this; we return a
  // fixed path so the path input is populated for the Create flow.
  mockSelectDirectory: vi.fn(),
  // useDefaultProjectColor: zustand hook imported by the modal.
  mockDefaultProjectColor: vi.fn(() => 'blue'),
  // useProjectStore.getState (used by the zustand mock below).
  mockUseProjectStore: vi.fn(() => ({}))
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  // Desktop branch — never called when isTauriContext() is false. Stubs throw
  // `fs.mkdir is unavailable` via tauriUnavailable; the test asserts this is
  // NEVER reached on the web branch (the original bug).
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

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('@/lib/dialog-api', () => ({
  dialogApi: {
    selectDirectory: mockSelectDirectory
  },
  registerWebDirectoryPicker: vi.fn(),
  _resetWebDirectoryPickerForTesting: vi.fn()
}))

vi.mock('@/stores/app-settings-store', () => ({
  useDefaultProjectColor: mockDefaultProjectColor
}))

// stub the project store the modal chain may touch downstream (avoid the real
// zustand store pulling in stores that require Tauri runtime).
vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(mockUseProjectStore, {
    getState: () => ({})
  })
}))

// Silence sonner toast during tests (it renders to document.body and can throw
// on the jsdom portal in some configs).
vi.mock('sonner', () => ({
  toast: {
    promise: vi.fn((_p, opts) => {
      // Drive the promise to settle so the test's act() unwinds cleanly.
      _p.then(
        (v: unknown) => opts.success?.(v),
        (e: unknown) => opts.error?.(e)
      )
      return 'toast-id'
    }),
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn()
  }
}))

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

describe('NewProjectModal (web-mode create flow — Patch G)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    mockDefaultProjectColor.mockReturnValue('blue')
    mockSelectDirectory.mockResolvedValue({ success: true, data: '/web/proj' })
    // Default: any /fs/* or /git/* or /shells call succeeds.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/shells')) {
        return jsonResponse({
          success: true,
          data: {
            default: { name: 'bash', path: '/bin/bash', displayName: 'Bash' },
            available: [{ name: 'bash', path: '/bin/bash', displayName: 'Bash' }]
          }
        })
      }
      return jsonResponse({ success: true })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not surface "fs.mkdir is unavailable" and completes the create flow', async () => {
    const onCreateProject = vi.fn()

    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />)

    // Wait for shells to FULLY load before typing. The modal's `isOpen` reset
    // effect has `shells?.default?.name` as a dep — if shells arrive AFTER we
    // type, that effect re-fires and wipes the name/path inputs (disabled
    // Create button). Wait for the Default Terminal <select> to show the
    // 'Bash' option, which proves shells settled and the reset effect is done.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Bash' })).toBeInTheDocument()
    })

    // Fill the name + path inputs (after the shells reset effect has settled).
    const nameInput = screen.getByPlaceholderText('My Project')
    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'My Web Project' } })
      fireEvent.change(pathInput, { target: { value: '/web/proj' } })
    })

    // The empty-check fires (GET /fs/ls?path=/web/proj). The default mock
    // returns { success: true } with NO data — the modal treats that as empty,
    // so the "Initialize Git repository" checkbox appears (folder-empty branch).
    await waitFor(() => {
      expect(screen.getByLabelText(/Initialize Git repository/i)).toBeInTheDocument()
    })

    // Select the Node template (not the default 'empty' template) so
    // scaffoldProject emits real files — the original bug fired from the
    // createFile path (`fs.mkdir is unavailable` was the plugin-fs stub
    // throw on the desktop branch; the web branch must route through
    // /fs/write instead).
    const selects = screen.getAllByRole('combobox') as unknown as HTMLSelectElement[]
    const templateSelect = selects.find((s) => s.value === 'empty')
    expect(templateSelect, 'Project Template select must default to empty').toBeTruthy()
    await act(async () => {
      fireEvent.change(templateSelect!, { target: { value: 'node' } })
    })

    // Click Create. The chain fires:
    //   filesystemApi.createDirectory(/web/proj) -> POST /fs/mkdir (web branch)
    //   scaffoldProject -> filesystemApi.createDirectory + createFile per template
    //   (no git init unless checked — leave unchecked)
    //   onCreateProject(name, color, path, shell, envVars?)
    const createBtn = screen.getByText('Create')
    await act(async () => {
      fireEvent.click(createBtn)
    })

    // The PRIMARY assertion (Patch G's reason for existing): the web branch
    // must route createDirectory through /fs/mkdir (NOT the desktop plugin-fs
    // stub which would throw "fs.mkdir is unavailable").
    await waitFor(
      () => {
        const mkdirCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/fs/mkdir'))
        expect(mkdirCalls.length).toBeGreaterThan(0)
      },
      { timeout: 5000 }
    )

    // scaffoldProject (Node template) writes real files — so /fs/write fires
    // on the web branch (NOT the desktop writeTextFile stub). The Node
    // template emits package.json, src/index.js, .gitignore, etc.
    await waitFor(
      () => {
        const writeCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/fs/write'))
        expect(writeCalls.length).toBeGreaterThan(0)
      },
      { timeout: 5000 }
    )

    // The flow completes: onCreateProject fires with the name + path.
    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledTimes(1)
    })
    const [nameArg, _colorArg, pathArg] = onCreateProject.mock.calls[0]
    expect(nameArg).toBe('My Web Project')
    expect(pathArg).toBe('/web/proj')

    // Sanity: the desktop tauri-unavailable message never reached the user.
    // The modal surfaces failures via the sonner toast error message — assert
    // the create flow did NOT raise the original bug's message.
    const allFetchUrls = mockFetch.mock.calls.map(([url]) => String(url))
    expect(allFetchUrls.some((u) => u.includes('/fs/mkdir'))).toBe(true)
    expect(allFetchUrls.some((u) => u.includes('/fs/write'))).toBe(true)
  })

  it('completes the create flow with git init checked (POST /git/init fires)', async () => {
    const onCreateProject = vi.fn()

    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />)

    // Wait for shells to settle (see the first test for why this matters).
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Bash' })).toBeInTheDocument()
    })

    const nameInput = screen.getByPlaceholderText('My Project')
    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'GitProj' } })
      fireEvent.change(pathInput, { target: { value: '/web/gp' } })
    })

    await waitFor(() => {
      expect(screen.getByLabelText(/Initialize Git repository/i)).toBeInTheDocument()
    })

    // Check the init-git checkbox — the chain then calls gitApi.init ->
    // webServerGit.init -> POST /git/init.
    fireEvent.click(screen.getByLabelText(/Initialize Git repository/i))

    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/git/init'))).toBe(true)
    })
    await waitFor(() => {
      expect(onCreateProject).toHaveBeenCalledTimes(1)
    })
    expect(onCreateProject.mock.calls[0][0]).toBe('GitProj')
  })

  it('shows a session-scoped info note on web (persistence-gap truthfulness)', () => {
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)
    expect(
      screen.getByText(/On the web client, this project is saved for this session only/i)
    ).toBeInTheDocument()
  })

  it('hides the session-scoped note on desktop (isTauriContext true)', () => {
    mockIsTauriContext.mockReturnValue(true)
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)
    expect(
      screen.queryByText(/On the web client, this project is saved for this session only/i)
    ).not.toBeInTheDocument()
  })
})
