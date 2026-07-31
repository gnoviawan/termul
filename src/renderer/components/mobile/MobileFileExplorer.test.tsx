import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorer } from './MobileFileExplorer'

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

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    createFile: (...args: unknown[]) => mockCreateFile(...args),
    createDirectory: (...args: unknown[]) => mockCreateDirectory(...args),
    deletePath: (...args: unknown[]) => mockDeletePath(...args),
    renameFile: (...args: unknown[]) => mockRenameFile(...args),
    copyFile: (...args: unknown[]) => mockCopyFile(...args)
  }
}))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) }
}))

// MaterialFileIcon pulls in the app-settings store + an SVG resolver; stub it
// (no name text) so row text assertions aren't duplicated by the icon span.
vi.mock('@/components/file-explorer/MaterialFileIcon', () => ({
  MaterialFileIcon: () => <span data-testid="mfi" />
}))

function entry(name: string, type: 'file' | 'directory', path?: string): DirectoryEntry {
  return {
    name,
    path: path ?? `/proj/${name}`,
    type,
    extension: type === 'file' && name.includes('.') ? name.split('.').pop()! : null,
    size: 0,
    modifiedAt: 0,
    ignored: false
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

  it('renders the Files header and lists root entries when open with a loaded root', async () => {
    setRoot([entry('a.txt', 'file'), entry('sub', 'directory')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Files')).toBeInTheDocument()
    expect(await screen.findByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
  })

  it('lazy-loads the root listing via toggleDirectory when opening with an empty root', async () => {
    // Root set, but no contents yet — the open effect must trigger the load.
    mockExplorerState.rootPath = '/proj'
    mockExplorerState.directoryContents = new Map()

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj'))
  })

  it('tapping a directory row calls toggleDirectory with its path', async () => {
    setRoot([entry('sub', 'directory')])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('sub'))
    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj/sub'))
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

  it('creates a new file via the facade then refreshes the root', async () => {
    setRoot([])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('New file'))
    const input = await screen.findByPlaceholderText('new-file.txt')
    fireEvent.change(input, { target: { value: 'made.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/proj/made.txt'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/proj'))
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
})
