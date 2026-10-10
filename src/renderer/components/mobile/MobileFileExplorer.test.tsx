import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSheetFocusReturnForTests,
  recordSheetOpener,
  setSheetFocusDestination
} from '@/lib/sheet-focus-return'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import {
  readOverlaySentinelDepth,
  useOverlayRegistration,
  useOverlayStackStore
} from '@/stores/overlay-stack-store'
import {
  buildFolderCrumbs,
  MobileFileExplorer,
  resolveBreadcrumbTarget
} from './MobileFileExplorer'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

let mockReducedMotion = false

vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        )
      )
    },
    useReducedMotion: () => mockReducedMotion
  }
})

const mockToggleDirectory = vi.fn().mockResolvedValue(undefined)
const mockRefreshDirectory = vi.fn().mockResolvedValue(undefined)
const mockSelectPath = vi.fn()
const mockCollapseAll = vi.fn()

const mockOpenFile = vi.fn()
const mockCloseFile = vi.fn()
const mockAddEditorTab = vi.fn()
const mockRemoveTab = vi.fn()

// Stable editor state object so tests can seed `openFiles` and have the
// component read the same map via `useEditorStore.getState()`.
const mockEditorStore = {
  openFile: mockOpenFile,
  openFiles: new Map<string, unknown>(),
  closeFile: mockCloseFile
}

const mockCreateFile = vi.fn()
const mockCreateDirectory = vi.fn()
const mockDeletePath = vi.fn()
const mockRenameFile = vi.fn()
const mockCopyFile = vi.fn()
const mockToastError = vi.fn()
const mockPersistenceRead = vi.fn()
const mockPersistenceWrite = vi.fn()
const mockLogFrontendError = vi.fn()
const mockFocusSheetIfLost = vi.fn()
let mockProjectId: string | undefined

// Mutable explorer state so individual tests can seed the tree (loaded root,
// empty root, load error, no project) without re-declaring the module mock.
const mockExplorerState = {
  rootPath: '/proj' as string | null,
  directoryContents: new Map<string, DirectoryEntry[]>(),
  expandedDirs: new Set<string>(),
  loadingDirs: new Set<string>(),
  rootLoadError: null as null | { message: string; code?: string }
}

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorer: () => mockExplorerState,
  useFileExplorerActions: () => ({
    toggleDirectory: mockToggleDirectory,
    refreshDirectory: mockRefreshDirectory,
    selectPath: mockSelectPath,
    collapseAll: mockCollapseAll
  })
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => mockEditorStore
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: vi.fn(() => ({
      addEditorTab: mockAddEditorTab,
      removeTab: mockRemoveTab
    }))
  },
  editorTabId: (path: string) => `edit-${path}`
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProjectId: () => mockProjectId
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    createFile: (...args: unknown[]) => mockCreateFile(...args),
    createDirectory: (...args: unknown[]) => mockCreateDirectory(...args),
    deletePath: (...args: unknown[]) => mockDeletePath(...args),
    renameFile: (...args: unknown[]) => mockRenameFile(...args),
    copyFile: (...args: unknown[]) => mockCopyFile(...args)
  },
  persistenceApi: {
    read: (...args: unknown[]) => mockPersistenceRead(...args),
    write: (...args: unknown[]) => mockPersistenceWrite(...args)
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => mockLogFrontendError(...args)
}))

// The real hook, with a spy on the call the delete confirm makes when it closes: jsdom's
// focus trap catches the fall to <body> that a browser leaves, so only the call is pinned.
vi.mock('./use-rename-focus-return', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-rename-focus-return')>()
  return {
    ...actual,
    useRenameFocusReturn: (...args: Parameters<typeof actual.useRenameFocusReturn>) => {
      const api = actual.useRenameFocusReturn(...args)
      return {
        ...api,
        focusSheetIfLost: () => {
          mockFocusSheetIfLost()
          api.focusSheetIfLost()
        }
      }
    }
  }
})

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) }
}))

// MaterialFileIcon pulls in the app-settings store + an SVG resolver; stub it
// (no name text) so row text assertions aren't duplicated by the icon span.
vi.mock('@/components/file-explorer/MaterialFileIcon', () => ({
  MaterialFileIcon: () => <span data-testid="mfi" />
}))

function entry(
  name: string,
  type: 'file' | 'directory',
  path?: string,
  ignored = false
): DirectoryEntry {
  return {
    name,
    path: path ?? `/proj/${name}`,
    type,
    extension: type === 'file' && name.includes('.') ? name.split('.').pop()! : null,
    size: 0,
    modifiedAt: 0,
    ignored
  }
}

function setRoot(entries: DirectoryEntry[]): void {
  mockExplorerState.rootPath = '/proj'
  mockExplorerState.directoryContents = new Map([['/proj', entries]])
  mockExplorerState.expandedDirs = new Set()
  mockExplorerState.loadingDirs = new Set()
  mockExplorerState.rootLoadError = null
}

describe('MobileFileExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectId = undefined
    mockPersistenceRead.mockReset()
    mockPersistenceWrite.mockReset()
    mockReducedMotion = false
    mockExplorerState.rootPath = '/proj'
    mockExplorerState.directoryContents = new Map()
    mockExplorerState.expandedDirs = new Set()
    mockExplorerState.loadingDirs = new Set()
    mockExplorerState.rootLoadError = null
    mockOpenFile.mockResolvedValue(true)
    mockCreateFile.mockResolvedValue({ success: true, data: undefined })
    mockCreateDirectory.mockResolvedValue({ success: true, data: undefined })
    mockDeletePath.mockResolvedValue({ success: true, data: undefined })
    mockRenameFile.mockResolvedValue({ success: true, data: undefined })
    mockCopyFile.mockResolvedValue({ success: true, data: undefined })
    mockEditorStore.openFiles.clear()
  })

  it('renders the project folder context and lists root entries when open', async () => {
    setRoot([entry('a.txt', 'file'), entry('sub', 'directory')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByText('Project files')).toBeInTheDocument()
    expect(await screen.findByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('lazy-loads the root listing via toggleDirectory when opening with an empty root', async () => {
    // Root set, but no contents yet — the open effect must trigger the load.
    mockExplorerState.rootPath = '/proj'
    mockExplorerState.directoryContents = new Map()

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('drills into a directory, loads it, and slides forward', async () => {
    setRoot([entry('sub', 'directory')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('sub'))

    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    // Below root the path line is the breadcrumb; its last segment is the
    // current folder.
    expect(screen.getByText('sub', { selector: '[aria-current="page"]' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'forward'
    )
    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj/sub'))
  })

  it('restores the persisted folder on open and keeps it on reopen', async () => {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj/sub' })
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])

    const { rerender } = render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    // First open restores the persisted subfolder, not the project root.
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(mockPersistenceRead).toHaveBeenCalledWith('mobile-file-explorer/proj-1')

    // Reopening keeps the user's folder — no reset to root, no re-read.
    mockPersistenceRead.mockClear()
    rerender(<MobileFileExplorer open={false} onOpenChange={vi.fn()} />)
    rerender(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(mockPersistenceRead).not.toHaveBeenCalled()
  })

  it('persists the folder on navigation and restores it on a fresh mount', async () => {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj' })
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])

    const { unmount } = render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()

    // Navigating into a subfolder writes the new folder to persistence.
    fireEvent.click(await screen.findByText('sub'))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(mockPersistenceWrite).toHaveBeenCalledWith('mobile-file-explorer/proj-1', '/proj/sub')

    // A fresh mount (page reload) restores the persisted folder.
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj/sub' })
    unmount()
    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
  })

  it('falls back to the project root when the persisted folder is outside the root', async () => {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/other-project/sub' })
    setRoot([entry('a.txt', 'file')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
    expect(mockPersistenceRead).toHaveBeenCalledWith('mobile-file-explorer/proj-1')
  })

  it('falls back to the project root when a persisted `..` path escapes the root', async () => {
    // `/proj/../other/sub` starts with the root prefix but resolves outside it.
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj/../other/sub' })
    setRoot([entry('a.txt', 'file')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).not.toBeInTheDocument()
  })

  it('restores a persisted path with dot segments as its resolved folder', async () => {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj/./sub/../src' })
    setRoot([entry('src', 'directory')])
    mockExplorerState.directoryContents.set('/proj/src', [])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'src' })).toBeInTheDocument()
    // The clean path drives the breadcrumb: no `.` or `..` crumb appears.
    const nav = await screen.findByRole('navigation', { name: 'Folder path' })
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['proj'])
    expect(within(nav).getByText('src')).toHaveAttribute('aria-current', 'page')
  })

  it('restores a canonical-cased persisted folder against a config-cased root (case-insensitive isWithinRoot)', async () => {
    // The persisted folder is canonical casing (`E:/proj/sub`, written from a
    // server-canonicalized entry.path) while the active root is config casing
    // (`e:/proj`). A case-sensitive isWithinRoot would reject it and clamp to
    // root on reload; the case-insensitive form restores the subfolder.
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: 'E:/proj/sub' })
    mockExplorerState.rootPath = 'e:/proj'
    mockExplorerState.directoryContents = new Map([
      ['e:/proj', [entry('sub', 'directory', 'E:/proj/sub')]],
      ['E:/proj/sub', []]
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(mockPersistenceRead).toHaveBeenCalledWith('mobile-file-explorer/proj-1')
  })

  it('restores the new project folder after a project switch', async () => {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj/sub' })
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])

    const { rerender } = render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()

    // Switch the active project: the drawer should restore that project's own
    // persisted folder, not keep the previous project's.
    mockExplorerState.rootPath = '/proj2'
    mockExplorerState.directoryContents = new Map([
      ['/proj2', [entry('deep', 'directory', '/proj2/deep')]],
      ['/proj2/deep', []]
    ])
    mockProjectId = 'proj-2'
    mockPersistenceRead.mockResolvedValue({ success: true, data: '/proj2/deep' })

    rerender(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'deep' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(mockPersistenceRead).toHaveBeenCalledWith('mobile-file-explorer/proj-2')
  })

  it('returns to the parent folder and slides back without going above root', async () => {
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [
      entry('inside.txt', 'file', '/proj/sub/inside.txt')
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('sub'))
    expect(await screen.findByText('inside.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Back to parent folder'))

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'back'
    )
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('navigates back to the parent (not root) when the stored root path casing differs from canonical entry paths', async () => {
    // The store holds the config casing (`e:/proj`), but the server
    // canonicalizes entry paths to on-disk casing (`E:/proj/...`). A
    // case-sensitive within-root comparison clamps back to root; the
    // case-insensitive comparison form returns the immediate parent.
    mockExplorerState.rootPath = 'e:/proj'
    mockExplorerState.directoryContents = new Map([
      ['e:/proj', [entry('sub', 'directory', 'E:/proj/sub')]],
      ['E:/proj/sub', [entry('child', 'directory', 'E:/proj/sub/child')]],
      ['E:/proj/sub/child', []]
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    // Drill two levels deep using the canonical entry paths.
    fireEvent.click(await screen.findByText('sub'))
    fireEvent.click(await screen.findByText('child'))
    expect(await screen.findByRole('heading', { name: 'child' })).toBeInTheDocument()

    // Back must return the immediate parent (`sub`), not clamp to root (`proj`).
    fireEvent.click(screen.getByLabelText('Back to parent folder'))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'back'
    )
    // One level below root → back stays enabled (proves we are not clamped).
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
  })

  it('preserves a Windows drive-root path when navigating back', async () => {
    mockExplorerState.rootPath = 'C:/'
    mockExplorerState.directoryContents = new Map([
      ['C:/', [entry('child', 'directory', 'C:/child')]],
      ['C:/child', [entry('inside.txt', 'file', 'C:/child/inside.txt')]]
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('child'))
    expect(await screen.findByText('inside.txt')).toBeInTheDocument()
    // Drive-root (`C:/`) subtitle must show the full child name, not drop a char.
    expect(screen.getByText('child', { selector: '[aria-current="page"]' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Back to parent folder'))

    expect(await screen.findByText('child')).toBeInTheDocument()
    expect(mockToggleDirectory).not.toHaveBeenCalledWith('C:')
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('returns the immediate parent (not root) when navigating back from a depth-2 path under a Windows drive root', async () => {
    // `parentOf("C:/Users/Alice/project")` must yield `C:/Users/Alice` and
    // never clamp to the `C:/` drive root. The drive-root identity
    // (`comparePath("C:/")` = `c:`, trailing slash stripped by
    // `pathIdentity`) makes `rootPrefix` `c:/` — not `c://` — so the slice +
    // identity re-check walks one level at a time down to the root.
    mockExplorerState.rootPath = 'C:/'
    mockExplorerState.directoryContents = new Map([
      ['C:/', [entry('Users', 'directory', 'C:/Users')]],
      ['C:/Users', [entry('Alice', 'directory', 'C:/Users/Alice')]],
      ['C:/Users/Alice', [entry('project', 'directory', 'C:/Users/Alice/project')]],
      ['C:/Users/Alice/project', []]
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    // Drill two levels below the drive root using canonical entry paths.
    fireEvent.click(await screen.findByText('Users'))
    fireEvent.click(await screen.findByText('Alice'))
    fireEvent.click(await screen.findByText('project'))
    expect(await screen.findByRole('heading', { name: 'project' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()

    // Back returns the immediate parent `Alice`, not the drive root.
    fireEvent.click(screen.getByLabelText('Back to parent folder'))
    expect(await screen.findByRole('heading', { name: 'Alice' })).toBeInTheDocument()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'back'
    )
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()

    // Back again returns `Users` (still not clamped to the drive root).
    fireEvent.click(screen.getByLabelText('Back to parent folder'))
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()

    // Final back lands on the drive root and disables the button.
    fireEvent.click(screen.getByLabelText('Back to parent folder'))
    expect(await screen.findByRole('heading', { name: 'C:' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('sorts visible entries exactly like desktop: directories, ignored state, then A-Z', async () => {
    setRoot([
      entry('z-file.txt', 'file'),
      entry('beta', 'directory', undefined, true),
      entry('Alpha.txt', 'file'),
      entry('Zoo', 'directory'),
      entry('alpha', 'directory'),
      entry('aardvark.txt', 'file', undefined, true)
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    const list = await screen.findByRole('list', { name: 'Files in proj' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['alpha', 'Zoo', 'beta', 'Alpha.txt', 'z-file.txt', 'aardvark.txt'])
  })

  it('disables slide movement when reduced motion is preferred', async () => {
    mockReducedMotion = true
    setRoot([entry('sub', 'directory')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('sub'))

    expect(await screen.findByTestId('mobile-folder-view')).toHaveAttribute(
      'data-reduced-motion',
      'true'
    )
  })

  it('tapping a file opens it in the editor and closes the drawer', async () => {
    setRoot([entry('a.txt', 'file')])

    const onOpenChange = vi.fn()
    render(<MobileFileExplorer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('a.txt'))

    await waitFor(() => expect(mockSelectPath).toHaveBeenCalledWith('/proj/a.txt'))
    await waitFor(() => expect(mockOpenFile).toHaveBeenCalledWith('/proj/a.txt'))
    await waitFor(() => expect(mockAddEditorTab).toHaveBeenCalledWith('/proj/a.txt'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('creates and refreshes inside the currently viewed directory', async () => {
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('sub'))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('New file'))
    const input = await screen.findByPlaceholderText('new-file.txt')
    fireEvent.change(input, { target: { value: 'made.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/proj/sub/made.txt'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj/sub'))

    mockRefreshDirectory.mockClear()
    fireEvent.click(screen.getByLabelText('Refresh current folder'))
    expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj/sub')
  })

  it('prevents navigation and a second create form while a create request is pending', async () => {
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])
    let resolveCreate: ((result: { success: true; data: undefined }) => void) | undefined
    mockCreateFile.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('sub'))
    fireEvent.click(screen.getByLabelText('New file'))
    const input = await screen.findByPlaceholderText('new-file.txt')
    fireEvent.change(input, { target: { value: 'made.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/proj/sub/made.txt'))
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
    expect(screen.getByLabelText('New file')).toBeDisabled()
    expect(input).toBeDisabled()

    resolveCreate?.({ success: true, data: undefined })
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj/sub'))
  })

  it('surfaces a server error code as a toast when create fails', async () => {
    setRoot([])
    mockCreateFile.mockResolvedValue({
      success: false,
      error: 'path traversal rejected',
      code: 'PATH_TRAVERSAL'
    })

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('New file'))
    const input = await screen.findByPlaceholderText('new-file.txt')
    fireEvent.change(input, { target: { value: 'bad.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith('Failed to create', {
      description: 'path traversal rejected'
    })
    // No mutation/refresh when the server refuses.
    expect(mockRefreshDirectory).not.toHaveBeenCalled()
  })

  it('deletes a file via the action sheet + confirm, reconciling an open editor tab', async () => {
    const file = entry('doomed.txt', 'file')
    setRoot([file])
    // Pretend the file is open in the editor so reconciliation fires.
    mockEditorStore.openFiles.set('/proj/doomed.txt', { isDirty: false })

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    // Open the row action sheet.
    fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
    fireEvent.click(await screen.findByText('Delete'))

    // The delete confirm is a Radix AlertDialog (stacks above the Sheet so it
    // stays accessible — a plain overlay inside #root would be aria-hidden by
    // the Sheet's inert). Scope the confirm button within the alertdialog to
    // avoid colliding with the action-sheet's "Delete" button during close.
    const dialog = await screen.findByRole('alertdialog')
    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete' })
    fireEvent.click(confirmBtn)

    await waitFor(() =>
      expect(mockDeletePath).toHaveBeenCalledWith('/proj/doomed.txt', {
        recursive: false
      })
    )
    await waitFor(() => expect(mockCloseFile).toHaveBeenCalledWith('/proj/doomed.txt'))
    await waitFor(() => expect(mockRemoveTab).toHaveBeenCalledWith('edit-/proj/doomed.txt'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('renames a file via Enter using the parentOf-derived target and reconciles the open tab', async () => {
    const file = entry('old.txt', 'file')
    setRoot([file])
    mockEditorStore.openFiles.set('/proj/old.txt', { isDirty: false })

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('Actions for old.txt'))
    fireEvent.click(await screen.findByText('Rename'))
    const input = await screen.findByLabelText('Rename old.txt')
    fireEvent.change(input, { target: { value: 'new.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // parentOf('/proj/old.txt') = '/proj' → '/proj/new.txt'.
    await waitFor(() =>
      expect(mockRenameFile).toHaveBeenCalledWith('/proj/old.txt', '/proj/new.txt')
    )
    // Clearing rename state before the await prevents a double submit.
    expect(mockRenameFile).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(mockCloseFile).toHaveBeenCalledWith('/proj/old.txt'))
    await waitFor(() => expect(mockRemoveTab).toHaveBeenCalledWith('edit-/proj/old.txt'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('renames a child directory and refreshes the current parent folder', async () => {
    const sub = entry('sub', 'directory')
    setRoot([sub])
    mockExplorerState.directoryContents.set('/proj/sub', [
      entry('child', 'directory', '/proj/sub/child')
    ])
    mockExplorerState.directoryContents.set('/proj/sub/child', [])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('sub'))
    fireEvent.click(await screen.findByText('child'))
    expect(await screen.findByRole('heading', { name: 'child' })).toBeInTheDocument()

    // Navigate back to the parent listing and rename its child directory.
    fireEvent.click(screen.getByLabelText('Back to parent folder'))
    fireEvent.click(await screen.findByLabelText('Actions for child'))
    fireEvent.click(await screen.findByText('Rename'))
    const input = await screen.findByLabelText('Rename child')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(mockRenameFile).toHaveBeenCalledWith('/proj/sub/child', '/proj/sub/renamed')
    )
    expect(screen.getByRole('heading', { name: 'sub' })).toBeInTheDocument()
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj/sub'))
  })

  it('renames a file via blur using the parentOf-derived target path', async () => {
    const file = entry('old.txt', 'file')
    setRoot([file])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('Actions for old.txt'))
    fireEvent.click(await screen.findByText('Rename'))
    const input = await screen.findByLabelText('Rename old.txt')
    fireEvent.change(input, { target: { value: 'new.txt' } })
    fireEvent.blur(input)

    await waitFor(() =>
      expect(mockRenameFile).toHaveBeenCalledWith('/proj/old.txt', '/proj/new.txt')
    )
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('duplicates a file into "<stem> copy<ext>" at the parentOf-derived path', async () => {
    const file = entry('note.txt', 'file')
    setRoot([file])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('Actions for note.txt'))
    fireEvent.click(await screen.findByText('Duplicate'))

    await waitFor(() =>
      expect(mockCopyFile).toHaveBeenCalledWith('/proj/note.txt', '/proj/note copy.txt')
    )
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('shows the root load error with a Retry button', async () => {
    mockExplorerState.rootPath = '/proj'
    // Keep the open effect from firing a load while the error is shown.
    mockExplorerState.loadingDirs = new Set(['/proj'])
    mockExplorerState.rootLoadError = { message: 'watch failed', code: 'WATCH_FAILED' }

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByText('watch failed')).toBeInTheDocument()
    fireEvent.click(await screen.findByText('Retry'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('shows the empty state when no project is active', async () => {
    mockExplorerState.rootPath = null

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByText('No active project')).toBeInTheDocument()
    // The new-file/new-folder actions are disabled without a root.
    expect(await screen.findByLabelText('New file')).toBeDisabled()
  })

  // ── Files breadcrumb: the header path is tappable segments ──────────────

  /** Opens the sheet on a persisted folder so a deep path is shown directly. */
  async function openAtFolder(
    root: string,
    folder: string,
    contents: Array<[string, DirectoryEntry[]]> = []
  ): Promise<HTMLElement> {
    mockProjectId = 'proj-1'
    mockPersistenceRead.mockResolvedValue({ success: true, data: folder })
    mockExplorerState.rootPath = root
    mockExplorerState.directoryContents = new Map(contents)
    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    return screen.findByRole('navigation', { name: 'Folder path' })
  }

  const crumbLabels = (nav: HTMLElement): string[] =>
    within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')

  it('splits the path below root into ancestor buttons and a plain current folder', async () => {
    const nav = await openAtFolder('/proj', '/proj/src/renderer/lib', [
      ['/proj/src/renderer/lib', []]
    ])

    expect(crumbLabels(nav)).toEqual(['proj', 'src', 'renderer'])
    const current = within(nav).getByText('lib')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(current.closest('button')).toBeNull()
    // Separators are decorative chevrons between segments, hidden from AT.
    const separators = nav.querySelectorAll('[data-termul-icon="ChevronRight"]')
    expect(separators).toHaveLength(3)
    for (const separator of separators) expect(separator).toHaveAttribute('aria-hidden', 'true')
    expect(nav.textContent).toBe('projsrcrendererlib')
    // The root-only line is replaced below root.
    expect(screen.queryByText('Project files')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'lib' })).toBeInTheDocument()
  })

  it('tapping an ancestor navigates there, slides back, persists the folder and loads the listing', async () => {
    const nav = await openAtFolder('/proj', '/proj/src/renderer/lib', [
      ['/proj/src/renderer/lib', []]
    ])
    mockToggleDirectory.mockClear()
    mockPersistenceWrite.mockClear()

    fireEvent.click(within(nav).getByRole('button', { name: 'src' }))

    expect(await screen.findByRole('heading', { name: 'src' })).toBeInTheDocument()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'back'
    )
    expect(mockPersistenceWrite).toHaveBeenCalledWith('mobile-file-explorer/proj-1', '/proj/src')
    // /proj/src was not cached, so the shown folder is loaded like any other.
    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj/src'))
    // The new current folder is plain text now; only the root stays a button.
    const updated = screen.getByRole('navigation', { name: 'Folder path' })
    expect(crumbLabels(updated)).toEqual(['proj'])
    expect(within(updated).getByText('src')).toHaveAttribute('aria-current', 'page')
  })

  it('tapping the root segment returns to the root and shows Project files', async () => {
    const nav = await openAtFolder('/proj', '/proj/src/renderer', [
      ['/proj', [entry('src', 'directory')]],
      ['/proj/src/renderer', []]
    ])

    fireEvent.click(within(nav).getByRole('button', { name: 'proj' }))

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByText('Project files')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'back'
    )
    expect(mockPersistenceWrite).toHaveBeenCalledWith('mobile-file-explorer/proj-1', '/proj')
  })

  it('shows Project files and no segments at the root', async () => {
    setRoot([entry('a.txt', 'file')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Project files')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).not.toBeInTheDocument()
  })

  it('disables the segment buttons while a create request is pending, like Back', async () => {
    const nav = await openAtFolder('/proj', '/proj/sub/deep', [['/proj/sub/deep', []]])
    let resolveCreate: ((result: { success: true; data: undefined }) => void) | undefined
    mockCreateFile.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )
    expect(within(nav).getByRole('button', { name: 'sub' })).toBeEnabled()

    fireEvent.click(screen.getByLabelText('New file'))
    const input = await screen.findByPlaceholderText('new-file.txt')
    fireEvent.change(input, { target: { value: 'made.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/proj/sub/deep/made.txt'))
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
    for (const button of within(nav).getAllByRole('button')) expect(button).toBeDisabled()

    resolveCreate?.({ success: true, data: undefined })
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj/sub/deep'))
    await waitFor(() => expect(within(nav).getByRole('button', { name: 'sub' })).toBeEnabled())
  })

  it('clears the inline create form when a segment is tapped', async () => {
    const nav = await openAtFolder('/proj', '/proj/sub/deep', [['/proj/sub/deep', []]])

    fireEvent.click(screen.getByLabelText('New folder'))
    expect(await screen.findByPlaceholderText('new-folder')).toBeInTheDocument()

    fireEvent.click(within(nav).getByRole('button', { name: 'sub' }))

    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('new-folder')).not.toBeInTheDocument()
  })

  it('clears the inline rename state when a segment is tapped', async () => {
    const nav = await openAtFolder('/proj', '/proj/sub/deep', [
      ['/proj/sub/deep', [entry('f.txt', 'file', '/proj/sub/deep/f.txt')]],
      ['/proj/sub', [entry('deep', 'directory', '/proj/sub/deep')]]
    ])

    fireEvent.click(await screen.findByLabelText('Actions for f.txt'))
    fireEvent.click(await screen.findByText('Rename'))
    expect(await screen.findByLabelText('Rename f.txt')).toBeInTheDocument()

    fireEvent.click(within(nav).getByRole('button', { name: 'sub' }))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()

    // Drill back into the folder where the rename was open: the row is a plain
    // row again, not a leftover rename input.
    fireEvent.click(await screen.findByText('deep'))
    expect(await screen.findByRole('heading', { name: 'deep' })).toBeInTheDocument()
    expect(await screen.findByText('f.txt')).toBeInTheDocument()
    expect(screen.queryByLabelText('Rename f.txt')).not.toBeInTheDocument()
    expect(mockRenameFile).not.toHaveBeenCalled()
  })

  it('preserves casing: ancestors are prefixes of the current path, the root segment is the stored root', async () => {
    const nav = await openAtFolder('e:/proj', 'E:/proj/sub/child', [
      ['E:/proj/sub/child', []],
      ['E:/proj/sub', []]
    ])
    expect(crumbLabels(nav)).toEqual(['proj', 'sub'])

    fireEvent.click(within(nav).getByRole('button', { name: 'sub' }))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()
    expect(mockPersistenceWrite).toHaveBeenCalledWith('mobile-file-explorer/proj-1', 'E:/proj/sub')

    const updated = screen.getByRole('navigation', { name: 'Folder path' })
    fireEvent.click(within(updated).getByRole('button', { name: 'proj' }))
    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(mockPersistenceWrite).toHaveBeenLastCalledWith('mobile-file-explorer/proj-1', 'e:/proj')
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('shows full names under a Windows drive root and the drive segment targets the drive root', async () => {
    const nav = await openAtFolder('C:/', 'C:/Users/Alice', [['C:/Users/Alice', []]])

    expect(crumbLabels(nav)).toEqual(['C:', 'Users'])
    expect(within(nav).getByText('Alice')).toHaveAttribute('aria-current', 'page')
    expect(nav.textContent).toBe('C:UsersAlice')

    fireEvent.click(within(nav).getByRole('button', { name: 'C:' }))

    expect(await screen.findByRole('heading', { name: 'C:' })).toBeInTheDocument()
    expect(mockPersistenceWrite).toHaveBeenCalledWith('mobile-file-explorer/proj-1', 'C:/')
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
  })

  it('gives each segment a vertical-only 44px hit area and clips the path from the left', async () => {
    const nav = await openAtFolder('/proj', '/proj/src/lib', [['/proj/src/lib', []]])

    for (const button of within(nav).getAllByRole('button')) {
      // 16px row + 14px slop on each side = 44px; inset-x-0 keeps neighbours
      // from overlapping and the header from growing.
      expect(button.className).toContain('h-4')
      expect(button.className).toContain('after:-inset-y-3.5')
      expect(button.className).toContain('after:inset-x-0')
      expect(button.className).not.toContain('after:-inset-1.5')
    }
    // Narrow widths: end-aligned + x-axis clip clips from the left, and the
    // current folder never shrinks away. The clip is x-only: `overflow-hidden`
    // would clip the vertical hit-slop above (jsdom has no layout, so the
    // class is the only observable).
    expect(nav.className).toContain('overflow-x-clip')
    expect(nav.className).not.toContain('overflow-hidden')
    expect(nav.className).toContain('justify-end')
    expect(within(nav).getByText('lib').className).toContain('shrink-0')
    // Semantic tokens only.
    expect(nav.className).toContain('text-muted-foreground')
    expect(within(nav).getByText('lib').className).toContain('text-foreground')
  })

  describe('navigateTo guard', () => {
    it('ignores a target outside the root and logs a warning', () => {
      expect(resolveBreadcrumbTarget('/other/sub', '/proj', '/proj/sub')).toBeNull()

      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'MobileFileExplorer.navigateTo' })
      )
    })

    it('ignores a target when there is no root and logs a warning', () => {
      expect(resolveBreadcrumbTarget('/proj/sub', null, null)).toBeNull()

      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'MobileFileExplorer.navigateTo' })
      )
    })

    it('does not mistake a sibling that shares the root prefix for a child', () => {
      expect(resolveBreadcrumbTarget('/proj-two/sub', '/proj', '/proj/sub')).toBeNull()
      expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    })

    it('is silent for the folder already shown and resolves a valid ancestor', () => {
      expect(resolveBreadcrumbTarget('/proj/sub', '/proj', '/proj/sub')).toBeNull()
      expect(resolveBreadcrumbTarget('E:/proj/sub', 'e:/proj', 'E:/proj/sub')).toBeNull()
      expect(resolveBreadcrumbTarget('/proj/src', '/proj', '/proj/src/lib')).toBe('/proj/src')
      expect(resolveBreadcrumbTarget('e:/proj', 'e:/proj', 'E:/proj/sub')).toBe('e:/proj')
      expect(mockLogFrontendError).not.toHaveBeenCalled()
    })

    it('resolves dot segments before the containment check', () => {
      // Lexically under `/proj` by prefix, but outside once `..` is applied.
      expect(resolveBreadcrumbTarget('/proj/../private', '/proj', '/proj/sub')).toBeNull()
      expect(resolveBreadcrumbTarget('/proj/..', '/proj', '/proj/sub')).toBeNull()
      expect(mockLogFrontendError).toHaveBeenCalledTimes(2)
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'MobileFileExplorer.navigateTo' })
      )

      // Dot segments that stay inside the root resolve to the clean folder.
      mockLogFrontendError.mockClear()
      expect(resolveBreadcrumbTarget('/proj/./sub/../src', '/proj', '/proj/sub/lib')).toBe(
        '/proj/src'
      )
      expect(mockLogFrontendError).not.toHaveBeenCalled()
    })

    it('keeps drive and posix roots when resolving dot segments', () => {
      expect(resolveBreadcrumbTarget('C:/Users/Alice/..', 'C:/', 'C:/Users/Alice')).toBe('C:/Users')
      // `..` cannot climb above a drive root.
      expect(resolveBreadcrumbTarget('C:\\Users\\..\\..', 'C:/', 'C:/Users/Alice')).toBe('C:/')
      expect(resolveBreadcrumbTarget('/usr/lib/..', '/', '/usr/lib')).toBe('/usr')
      expect(resolveBreadcrumbTarget('/usr/../../..', '/', '/usr/lib')).toBe('/')
      expect(mockLogFrontendError).not.toHaveBeenCalled()
    })

    it('builds no crumbs at or outside the root', () => {
      expect(buildFolderCrumbs('/proj', '/proj')).toBeNull()
      expect(buildFolderCrumbs('/proj', '/elsewhere/sub')).toBeNull()
      expect(buildFolderCrumbs('/', '/usr/lib')).toEqual({
        ancestors: [
          { label: '/', path: '/' },
          { label: 'usr', path: '/usr' }
        ],
        currentLabel: 'lib'
      })
    })
  })
})

/**
 * Focus return (a11y floor). Radix returns focus on close only to a
 * Dialog.Trigger, and these sheets are opened by plain buttons, so focus used
 * to fall to <body>. The explorer's sheets now return it to the recorded opener,
 * or to the destination the shell hands over once a file opened.
 */
describe('MobileFileExplorer focus return', () => {
  /** Mirrors the shell: a "Browse files" opener, a header title, and the explorer. */
  function Harness({ withDestination = true }: { withDestination?: boolean }) {
    const [open, setOpen] = useState(false)
    const titleRef = useRef<HTMLHeadingElement>(null)
    return (
      <>
        <button
          type="button"
          onClick={(event) => {
            recordSheetOpener('files-sheet', event.currentTarget)
            setOpen(true)
          }}
        >
          Browse files
        </button>
        <h1 ref={titleRef} tabIndex={-1}>
          Header title
        </h1>
        <MobileFileExplorer
          open={open}
          onOpenChange={setOpen}
          onFileOpened={
            withDestination
              ? () => setSheetFocusDestination('files-sheet', titleRef.current)
              : undefined
          }
        />
      </>
    )
  }

  async function openFiles(): Promise<HTMLElement> {
    const opener = screen.getByRole('button', { name: 'Browse files' })
    fireEvent.click(opener)
    await screen.findByRole('dialog')
    return opener
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetSheetFocusReturnForTests()
    mockProjectId = undefined
    mockPersistenceRead.mockReset()
    mockPersistenceWrite.mockReset()
    mockReducedMotion = false
    mockOpenFile.mockResolvedValue(true)
    mockCopyFile.mockResolvedValue({ success: true, data: undefined })
    mockDeletePath.mockResolvedValue({ success: true, data: undefined })
    mockRenameFile.mockResolvedValue({ success: true, data: undefined })
    mockRefreshDirectory.mockReset()
    mockRefreshDirectory.mockResolvedValue(undefined)
    mockEditorStore.openFiles.clear()
    ;(document.activeElement as HTMLElement | null)?.blur()
  })

  it('returns focus to the opener when the sheet closes via its Close button', async () => {
    setRoot([entry('a.txt', 'file')])
    render(<Harness />)
    const opener = await openFiles()
    await screen.findByText('a.txt')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('returns focus to the opener when Escape closes the sheet', async () => {
    setRoot([entry('a.txt', 'file')])
    render(<Harness />)
    const opener = await openFiles()
    await screen.findByText('a.txt')

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('moves focus to the destination, not the opener, when a file opened', async () => {
    setRoot([entry('a.txt', 'file')])
    render(<Harness />)
    await openFiles()

    fireEvent.click(await screen.findByText('a.txt'))

    await waitFor(() => expect(mockAddEditorTab).toHaveBeenCalledWith('/proj/a.txt'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Header title' }))
    )
  })

  it('falls back to the opener when no destination is handed over', async () => {
    setRoot([entry('a.txt', 'file')])
    render(<Harness withDestination={false} />)
    const opener = await openFiles()

    fireEvent.click(await screen.findByText('a.txt'))

    await waitFor(() => expect(mockAddEditorTab).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('does not call onFileOpened when opening the file fails', async () => {
    setRoot([entry('a.txt', 'file')])
    mockOpenFile.mockRejectedValue(new Error('boom'))
    const onFileOpened = vi.fn()
    render(<MobileFileExplorer open onOpenChange={vi.fn()} onFileOpened={onFileOpened} />)

    fireEvent.click(await screen.findByText('a.txt'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(onFileOpened).not.toHaveBeenCalled()
  })

  describe('file-actions sheet', () => {
    it('returns focus to the row Actions button when it is dismissed', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      await openFiles()
      const actions = await screen.findByLabelText('Actions for note.txt')

      fireEvent.click(actions)
      await screen.findByText('Duplicate')
      fireEvent.keyDown(document, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByText('Duplicate')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(actions))
      // The Files sheet itself is still open underneath.
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('returns focus to the row Actions button when Duplicate is chosen', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      await openFiles()
      const actions = await screen.findByLabelText('Actions for note.txt')

      fireEvent.click(actions)
      fireEvent.click(await screen.findByText('Duplicate'))

      await waitFor(() => expect(mockCopyFile).toHaveBeenCalled())
      await waitFor(() => expect(screen.queryByText('Duplicate')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(actions))
    })

    it('leaves focus in the delete confirm when Delete is chosen', async () => {
      setRoot([entry('doomed.txt', 'file')])
      render(<Harness />)
      await openFiles()

      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      fireEvent.click(await screen.findByText('Delete'))

      const confirm = await screen.findByRole('alertdialog')
      // Radix fires the actions sheet's onCloseAutoFocus in a setTimeout(0);
      // wait it out and check that the confirm kept focus rather than the
      // actions button taking it back.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(confirm.contains(document.activeElement)).toBe(true)
    })

    it('leaves focus on the rename input when Rename is chosen', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      await openFiles()

      fireEvent.click(await screen.findByLabelText('Actions for note.txt'))
      fireEvent.click(await screen.findByText('Rename'))

      const input = await screen.findByLabelText('Rename note.txt')
      await waitFor(() => expect(screen.queryByText('Duplicate')).not.toBeInTheDocument())
      // Radix fires onCloseAutoFocus in a setTimeout(0); wait it out and check
      // that the autofocused input kept focus.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(document.activeElement).toBe(input)
    })
  })

  describe('delete confirm', () => {
    async function openConfirm(
      name: string
    ): Promise<{ actions: HTMLElement; confirm: HTMLElement }> {
      await openFiles()
      const actions = await screen.findByLabelText(`Actions for ${name}`)
      fireEvent.click(actions)
      fireEvent.click(await screen.findByText('Delete'))
      const confirm = await screen.findByRole('alertdialog')
      // Radix fires the actions sheet's own onCloseAutoFocus in a setTimeout(0).
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { actions, confirm }
    }

    it('returns focus to the row Actions button when Cancel is pressed', async () => {
      setRoot([entry('doomed.txt', 'file')])
      render(<Harness />)
      const { actions } = await openConfirm('doomed.txt')

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(actions))
      expect(document.activeElement).not.toBe(document.body)
      // The Files sheet stays open underneath, and nothing was deleted.
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(mockDeletePath).not.toHaveBeenCalled()
    })

    it('returns focus to the row Actions button when Escape dismisses it', async () => {
      setRoot([entry('doomed.txt', 'file')])
      render(<Harness />)
      const { actions } = await openConfirm('doomed.txt')

      fireEvent.keyDown(document, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(actions))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(mockDeletePath).not.toHaveBeenCalled()
    })

    it('deletes once and returns focus to the connected Actions button, never to body', async () => {
      setRoot([entry('doomed.txt', 'file')])
      render(<Harness />)
      const { actions } = await openConfirm('doomed.txt')

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(actions))
      expect(mockDeletePath).toHaveBeenCalledTimes(1)
      expect(mockDeletePath).toHaveBeenCalledWith('/proj/doomed.txt', { recursive: false })
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('hands a focus the closing confirm dropped to the Files sheet, for a row that is already gone', async () => {
      // A local delete finishes before the confirm's exit animation does, so the
      // recorded Actions button can be disconnected when the confirm hands focus
      // back and nothing underneath is trapping it yet.
      setRoot([entry('doomed.txt', 'file'), entry('kept.txt', 'file')])
      const view = render(<Harness />)
      mockDeletePath.mockImplementationOnce(() => {
        setRoot([entry('kept.txt', 'file')])
        act(() => view.rerender(<Harness />))
        return Promise.resolve({ success: true, data: undefined })
      })
      await openConfirm('doomed.txt')
      expect(mockFocusSheetIfLost).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() => expect(mockFocusSheetIfLost).toHaveBeenCalledTimes(1))
      expect(screen.queryByLabelText('Actions for doomed.txt')).not.toBeInTheDocument()
      const sheet = screen.getByRole('dialog')
      expect(sheet.contains(document.activeElement)).toBe(true)
      expect(document.activeElement).not.toBe(document.body)
      expect(mockDeletePath).toHaveBeenCalledTimes(1)
    })

    it('leaves focus alone and logs at info when no opener is connected', async () => {
      setRoot([entry('doomed.txt', 'file')])
      render(<Harness />)
      await openConfirm('doomed.txt')
      // Nothing is recorded for the actions sheet any more.
      _resetSheetFocusReturnForTests()

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(mockLogFrontendError).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'info',
            source: 'sheet-focus-return',
            message: 'Sheet closed with no connected focus target: file-actions-sheet'
          })
        )
      )
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })
  })

  describe('rename end', () => {
    async function startRename(name: string): Promise<HTMLInputElement> {
      await openFiles()
      fireEvent.click(await screen.findByLabelText(`Actions for ${name}`))
      fireEvent.click(await screen.findByText('Rename'))
      const input = (await screen.findByLabelText(`Rename ${name}`)) as HTMLInputElement
      await waitFor(() => expect(screen.queryByText('Duplicate')).not.toBeInTheDocument())
      // Radix fires the actions sheet's onCloseAutoFocus in a setTimeout(0).
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(document.activeElement).toBe(input)
      return input
    }

    function actionsFor(name: string): HTMLElement {
      return screen.getByLabelText(`Actions for ${name}`)
    }

    it('returns focus to the row Actions button when Escape ends the rename', async () => {
      setRoot([entry('note.txt', 'file'), entry('other.txt', 'file')])
      render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.keyDown(input, { key: 'Escape' })

      await waitFor(() =>
        expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
      // Escape cancels the rename only: the Files sheet stays open.
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(mockRenameFile).not.toHaveBeenCalled()
    })

    it('returns focus to the row Actions button when Enter leaves the name unchanged', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
      expect(mockRenameFile).not.toHaveBeenCalled()
    })

    it('consumes the Enter key, so its keypress cannot press the Actions button that takes focus', async () => {
      // Enter on an unchanged name moves focus to the row's Actions button inside the keydown.
      // A browser then dispatches the keypress for the same Enter to that button, which
      // activates it and opens the file actions sheet, unless the keydown was prevented.
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      const input = await startRename('note.txt')

      const notPrevented = fireEvent.keyDown(input, { key: 'Enter' })

      expect(notPrevented).toBe(false)
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
      expect(screen.queryByText('Duplicate')).not.toBeInTheDocument()
    })

    it('returns focus to the row Actions button when Enter leaves the name empty', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
      expect(mockRenameFile).not.toHaveBeenCalled()
    })

    it('returns focus to the row Actions button when the input blurs with no change', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.blur(input)

      await waitFor(() =>
        expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
    })

    it('focuses the renamed row Actions button once the refreshed listing shows it', async () => {
      setRoot([entry('note.txt', 'file')])
      mockRefreshDirectory.mockImplementation(async () => {
        setRoot([entry('renamed.txt', 'file')])
      })
      const view = render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.change(input, { target: { value: 'renamed.txt' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(mockRenameFile).toHaveBeenCalledWith('/proj/note.txt', '/proj/renamed.txt')
      )
      await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
      // Until the listing shows the renamed row, the stale row never takes focus.
      expect(document.activeElement).not.toBe(actionsFor('note.txt'))

      view.rerender(<Harness />)

      await waitFor(() => expect(document.activeElement).toBe(actionsFor('renamed.txt')))
    })

    it('returns focus to the original row Actions button when the rename fails', async () => {
      setRoot([entry('note.txt', 'file')])
      mockRenameFile.mockResolvedValue({ success: false, error: 'exists' })
      render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.change(input, { target: { value: 'taken.txt' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename', { description: 'exists' })
      )
      await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
    })

    describe('listing paths with a prefix the root path lacks (a Windows host)', () => {
      // `termul-server` on Windows lists canonicalised `\\?\C:\...` paths while the
      // project root is a plain `C:/proj`, so `parentOf` cannot rebuild the row's own path.
      const prefixed = (name: string): DirectoryEntry =>
        entry(name, 'file', `\\\\?\\C:\\proj\\${name}`)

      function setPrefixedRoot(entries: DirectoryEntry[]): void {
        setRoot(entries)
        mockExplorerState.rootPath = 'C:/proj'
        mockExplorerState.directoryContents = new Map([['C:/proj', entries]])
      }

      it('treats an unchanged name as unchanged: no rename call, and the row Actions button takes focus', async () => {
        setPrefixedRoot([prefixed('note.txt')])
        render(<Harness />)
        const input = await startRename('note.txt')

        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() =>
          expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
        )
        await waitFor(() => expect(document.activeElement).toBe(actionsFor('note.txt')))
        expect(mockRenameFile).not.toHaveBeenCalled()
      })

      it('focuses the renamed row Actions button once the refreshed listing shows it', async () => {
        setPrefixedRoot([prefixed('note.txt')])
        mockRefreshDirectory.mockImplementation(async () => {
          setPrefixedRoot([prefixed('renamed.txt')])
        })
        const view = render(<Harness />)
        const input = await startRename('note.txt')

        fireEvent.change(input, { target: { value: 'renamed.txt' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('C:/proj'))
        expect(mockRenameFile).toHaveBeenCalledWith(
          prefixed('note.txt').path,
          'C:/proj/renamed.txt'
        )
        view.rerender(<Harness />)

        await waitFor(() => expect(document.activeElement).toBe(actionsFor('renamed.txt')))
      })
    })

    it('leaves focus on the control the user moved it to', async () => {
      setRoot([entry('note.txt', 'file')])
      render(<Harness />)
      await startRename('note.txt')
      const refresh = screen.getByLabelText('Refresh current folder')

      act(() => refresh.focus())

      await waitFor(() =>
        expect(screen.queryByLabelText('Rename note.txt')).not.toBeInTheDocument()
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(document.activeElement).toBe(refresh)
    })

    it('does not take focus the user moved while the renamed row was pending', async () => {
      setRoot([entry('note.txt', 'file')])
      mockRefreshDirectory.mockImplementation(async () => {
        setRoot([entry('renamed.txt', 'file')])
      })
      const view = render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.change(input, { target: { value: 'renamed.txt' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
      const refresh = screen.getByLabelText('Refresh current folder')
      act(() => refresh.focus())

      view.rerender(<Harness />)

      await screen.findByLabelText('Actions for renamed.txt')
      expect(document.activeElement).toBe(refresh)
    })

    it('drops a pending return when the folder changes before the renamed row shows', async () => {
      setRoot([entry('note.txt', 'file'), entry('sub', 'directory')])
      mockExplorerState.directoryContents.set('/proj/sub', [
        entry('inner.txt', 'file', '/proj/sub/inner.txt')
      ])
      mockRefreshDirectory.mockImplementation(async () => {
        mockExplorerState.directoryContents.set('/proj', [
          entry('renamed.txt', 'file'),
          entry('sub', 'directory')
        ])
      })
      const view = render(<Harness />)
      const input = await startRename('note.txt')

      fireEvent.change(input, { target: { value: 'renamed.txt' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
      // The user goes into a folder, then back to the root where the renamed row now shows.
      fireEvent.click(screen.getByLabelText('Open folder sub'))
      await screen.findByLabelText('Actions for inner.txt')
      fireEvent.click(screen.getByLabelText('Back to parent folder'))
      view.rerender(<Harness />)

      await screen.findByLabelText('Actions for renamed.txt')
      expect(document.activeElement).not.toBe(actionsFor('renamed.txt'))
    })
  })
})

describe('MobileFileExplorer overlay back stack', () => {
  let cleanup: () => void

  /** Registers the Files sheet the way MobileChatShell does (own state + close). */
  function FilesSheetHarness(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    useOverlayRegistration('files-sheet', open, () => setOpen(false))
    return <MobileFileExplorer open={open} onOpenChange={setOpen} />
  }

  const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectId = undefined
    mockReducedMotion = false
    mockEditorStore.openFiles.clear()
    mockDeletePath.mockResolvedValue({ success: true, data: undefined })
    mockRenameFile.mockResolvedValue({ success: true, data: undefined })
    setRoot([entry('doomed.txt', 'file')])
    // A route entry below the base entry, so a route back has somewhere to go.
    window.history.replaceState(null, '', '#/route-a')
    window.history.pushState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers the row actions above the Files sheet and back closes only the row actions', async () => {
      render(<FilesSheetHarness />)
      await waitForSentinelDepth(1)

      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      expect(await screen.findByText('Rename')).toBeInTheDocument()
      expect(stackIds()).toEqual(['files-sheet', 'mobile-file-actions'])
      await waitForSentinelDepth(2)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByText('Rename')).not.toBeInTheDocument())
      expect(stackIds()).toEqual(['files-sheet'])
      expect(screen.getByRole('heading', { name: 'proj' })).toBeInTheDocument()
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(1)
    })

    it('Delete swaps the row actions for the confirm without a traversal, then two backs leave no dead press', async () => {
      render(<FilesSheetHarness />)
      await waitForSentinelDepth(1)
      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      await waitForSentinelDepth(2)
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const pushSpy = vi.spyOn(history, 'pushState')

      fireEvent.click(await screen.findByText('Delete'))

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
      await settleOverlayBackStack()
      expect(stackIds()).toHaveLength(2)
      expect(stackIds()[0]).toBe('files-sheet')
      expect(stackIds()[1]).toMatch(/^alert-dialog:/)
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
      expect(pushSpy).not.toHaveBeenCalled()
      expect(readOverlaySentinelDepth(history.state)).toBe(2)

      // First back: only the delete confirm closes.
      await pressSystemBack()
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(screen.getByRole('heading', { name: 'proj' })).toBeInTheDocument()
      expect(mockDeletePath).not.toHaveBeenCalled()
      expect(stackIds()).toEqual(['files-sheet'])

      // Second back: the Files sheet closes. Neither press was dead.
      await pressSystemBack()
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'proj' })).not.toBeInTheDocument()
      )
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a row action that closes the row sheet (Rename) consumes its sentinel', async () => {
      render(<FilesSheetHarness />)
      await waitForSentinelDepth(1)
      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      await waitForSentinelDepth(2)

      fireEvent.click(await screen.findByText('Rename'))

      expect(await screen.findByLabelText('Rename doomed.txt')).toBeInTheDocument()
      await waitForSentinelDepth(1)
      expect(stackIds()).toEqual(['files-sheet'])
    })

    it('does not keep a phantom row-actions overlay when the Files sheet closes under it', async () => {
      const { rerender } = render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      expect(await screen.findByText('Rename')).toBeInTheDocument()
      expect(stackIds()).toEqual(['mobile-file-actions'])
      await waitForSentinelDepth(1)

      // The parent closes the Files sheet; the nested row sheet unmounts with it.
      rerender(<MobileFileExplorer open={false} onOpenChange={vi.fn()} />)

      await waitFor(() => expect(stackIds()).toEqual([]))
      await waitForSentinelDepth(0)
    })
  })

  describe('desktop shell', () => {
    it('is inert: the row sheet is not registered and nothing is pushed or traversed', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

      fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
      expect(await screen.findByText('Rename')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.click(screen.getByText('Rename'))
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
