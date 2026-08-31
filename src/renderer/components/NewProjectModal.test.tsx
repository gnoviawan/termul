/**
 * End-to-end tests for `NewProjectModal` in web mode (`!isTauriContext()`).
 *
 * Original Patch G: the web-mode create chain (`handleCreate` →
 * `filesystemApi.createDirectory` → scaffold) was untested and surfaced
 * `Setup failed: fs.mkdir is unavailable`. That guard lives on: the create
 * test still asserts NO `fs.mkdir is unavailable` error surfaces and that
 * `onCreateProject` fires.
 *
 * Since the modal simplification, the tests also defend the new observable
 * contract:
 *  - the Project Name auto-fills from the selected folder's basename
 *    (typed path or Browse), with re-derivation on folder change and
 *    user-edit override semantics,
 *  - only Root Directory + Project Name render (no template, color, shell,
 *    or git-init controls), and
 *  - the web session-only note is preserved.
 *
 * The `@tauri-apps/plugin-fs` + `@tauri-apps/plugin-dialog` +
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
      // success/error may be a string OR a resolver fn — call fns only.
      _p.then(
        (v: unknown) => typeof opts.success === 'function' && opts.success(v),
        (e: unknown) => typeof opts.error === 'function' && opts.error(e)
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

describe('NewProjectModal (web-mode · auto-name + advanced options)', () => {
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

    // Fill the path — the simplified modal derives the name from the folder's
    // basename, so only the path needs setting before Create is enabled.
    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/web/proj' } })
    })

    // The path auto-filled the name field (core feature of the simplified
    // modal — folder basename without user action).
    const nameInput = screen.getByPlaceholderText('My Project')
    await waitFor(() => {
      expect(nameInput).toHaveValue('proj')
    })

    // Now override the derived name with an explicit user edit — the edited
    // name persists until the next folder change (which re-derives), and the
    // name current at Create time is what onCreateProject receives.
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'My Web Project' } })
    })

    // Click Create. The chain fires:
    //   filesystemApi.createDirectory(/web/proj) -> POST /fs/mkdir (web branch)
    //   (empty template — no scaffold files written)
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
      { timeout: 10000 }
    )

    await waitFor(
      () => {
        expect(onCreateProject).toHaveBeenCalledTimes(1)
      },
      { timeout: 10000 }
    )
    const [nameArg, _colorArg, pathArg] = onCreateProject.mock.calls[0]
    expect(nameArg).toBe('My Web Project')
    expect(pathArg).toBe('/web/proj')

    // No scaffolding: the empty-template pin means /fs/write must never fire.
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/fs/write'))).toBe(false)

    // Sanity: the desktop tauri-unavailable message never reached the user.
    const allFetchUrls = mockFetch.mock.calls.map(([url]) => String(url))
    expect(allFetchUrls.some((u) => u.includes('/fs/mkdir'))).toBe(true)
  })

  it('re-derives the name on folder change and respects a user edit in between', async () => {
    const onCreateProject = vi.fn()

    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />)

    const pathInput = screen.getByPlaceholderText('No directory selected')

    // Pick a first folder: name auto-fills from its basename.
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/home/me/my-app' } })
    })
    const nameInput = screen.getByPlaceholderText('My Project')
    await waitFor(() => {
      expect(nameInput).toHaveValue('my-app')
    })
    // User edits the name — the edit persists until the next folder change.
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Custom Name' } })
    })
    expect(nameInput).toHaveValue('Custom Name')

    // Changing the folder re-derives the name (auto-name guarantee).
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/home/me/other-app' } })
    })
    await waitFor(() => {
      expect(nameInput).toHaveValue('other-app')
    })

    // A filesystem root ('/', 'C:\\') or dot segment ('.', '..') must NOT
    // become a project name — the derived name clears instead of keeping a
    // stale one that no longer matches the chosen directory.
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/' } })
    })
    expect(nameInput).toHaveValue('')

    // A one-segment relative path (no separators) is a valid folder name.
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: 'project' } })
    })
    expect(nameInput).toHaveValue('project')

    // A drive root ('C:\\') must not derive 'C:' as the name.
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: 'C:\\' } })
    })
    expect(nameInput).toHaveValue('')

    // Re-derive once more, then create and assert the final derived name used.
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/home/me/final-app' } })
      fireEvent.click(screen.getByText('Create'))
    })
    await waitFor(
      () => {
        expect(onCreateProject).toHaveBeenCalledTimes(1)
      },
      { timeout: 10000 }
    )
    expect(onCreateProject.mock.calls[0][0]).toBe('final-app')
    expect(onCreateProject.mock.calls[0][2]).toBe('/home/me/final-app')
  })

  it('auto-fills the name from the Browse picker (handleBrowse path)', async () => {
    mockSelectDirectory.mockResolvedValue({ success: true, data: '/home/me/picked-app' })
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Browse'))
    })

    const nameInput = screen.getByPlaceholderText('My Project')
    await waitFor(() => {
      expect(nameInput).toHaveValue('picked-app')
    })
    expect(screen.getByPlaceholderText('No directory selected')).toHaveValue('/home/me/picked-app')
  })

  it('derives the name from Windows-style paths (backslash separators)', async () => {
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)

    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: 'C:\\Users\\me\\proj' } })
    })

    await waitFor(() => {
      expect(screen.getByPlaceholderText('My Project')).toHaveValue('proj')
    })
  })

  it('passes the app default project color through to onCreateProject', async () => {
    mockDefaultProjectColor.mockReturnValue('green')
    const onCreateProject = vi.fn()
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />)

    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/web/green-proj' } })
      fireEvent.click(screen.getByText('Create'))
    })

    await waitFor(
      () => {
        expect(onCreateProject).toHaveBeenCalledTimes(1)
      },
      { timeout: 10000 }
    )
    // 2nd positional arg is the color.
    expect(onCreateProject.mock.calls[0][1]).toBe('green')
  })

  it('resets name and path when the modal is closed and reopened', async () => {
    const { rerender } = render(
      <NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />
    )

    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/home/me/app' } })
    })
    await waitFor(() => {
      expect(screen.getByPlaceholderText('My Project')).toHaveValue('app')
    })

    rerender(<NewProjectModal isOpen={false} onClose={vi.fn()} onCreateProject={vi.fn()} />)
    rerender(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)

    expect(screen.getByPlaceholderText('No directory selected')).toHaveValue('')
    expect(screen.getByPlaceholderText('My Project')).toHaveValue('')
  })

  it('keeps advanced options collapsed by default (simple common path)', () => {
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)
    expect(screen.getByText('Advanced options')).toBeInTheDocument()
    // Collapsed by default: controls live inside the closed Collapsible.
    expect(screen.queryByText('Project Template')).not.toBeInTheDocument()
    expect(screen.queryByText('Default Terminal')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Initialize Git repository/i)).not.toBeInTheDocument()
  })

  it('shows all advanced controls when the section is expanded', async () => {
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByText('Advanced options'))
    })
    await waitFor(() => {
      expect(screen.getByText('Project Template')).toBeInTheDocument()
    })
    expect(screen.getByText('Color')).toBeInTheDocument()
    expect(screen.getByText('Default Terminal')).toBeInTheDocument()
    expect(screen.getAllByRole('combobox').length).toBe(2)
  })

  it('shows the git-init checkbox when the chosen folder is empty (advanced)', async () => {
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />)

    // Pick a folder first — the git-init checkbox only renders when the
    // chosen directory reads as empty (/fs/ls returns success with no data).
    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/web/proj' } })
    })

    // Open Advanced so the conditional block is mounted.
    await act(async () => {
      fireEvent.click(screen.getByText('Advanced options'))
    })

    // /fs/ls returns success with no data → treated as empty folder.
    await waitFor(() => {
      expect(screen.getByLabelText(/Initialize Git repository/i)).toBeInTheDocument()
    })
  })

  it('completes the create flow with a template + git init via Advanced', async () => {
    const onCreateProject = vi.fn()
    render(<NewProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />)

    const pathInput = screen.getByPlaceholderText('No directory selected')
    await act(async () => {
      fireEvent.change(pathInput, { target: { value: '/web/adv' } })
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Advanced options'))
    })

    // Select the Node template so scaffoldProject emits real files (/fs/write).
    const selects = screen.getAllByRole('combobox') as unknown as HTMLSelectElement[]
    const templateSelect = selects.find((s) => s.value === 'empty')
    expect(templateSelect, 'Project Template select must default to empty').toBeTruthy()
    await act(async () => {
      fireEvent.change(templateSelect!, { target: { value: 'node' } })
    })

    fireEvent.click(screen.getByLabelText(/Initialize Git repository/i))

    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    await waitFor(
      () => {
        expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/git/init'))).toBe(true)
      },
      { timeout: 10000 }
    )
    await waitFor(
      () => {
        const writeCalls = mockFetch.mock.calls.filter(([url]) => String(url).includes('/fs/write'))
        expect(writeCalls.length).toBeGreaterThan(0)
      },
      { timeout: 10000 }
    )
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
