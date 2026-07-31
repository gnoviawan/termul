import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorer } from './MobileFileExplorer'

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
    expect(screen.getByText('sub', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeEnabled()
    expect(screen.getByTestId('mobile-folder-view')).toHaveAttribute(
      'data-navigation-direction',
      'forward'
    )
    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/proj/sub'))
  })

  it('resets to the project root when the drawer is reopened', async () => {
    setRoot([entry('sub', 'directory')])
    mockExplorerState.directoryContents.set('/proj/sub', [])

    const { rerender } = render(<MobileFileExplorer open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByText('sub'))
    expect(await screen.findByRole('heading', { name: 'sub' })).toBeInTheDocument()

    rerender(<MobileFileExplorer open={false} onOpenChange={vi.fn()} />)
    rerender(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to parent folder')).toBeDisabled()
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

  it('preserves a Windows drive-root path when navigating back', async () => {
    mockExplorerState.rootPath = 'C:/'
    mockExplorerState.directoryContents = new Map([
      ['C:/', [entry('child', 'directory', 'C:/child')]],
      ['C:/child', [entry('inside.txt', 'file', 'C:/child/inside.txt')]]
    ])

    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByText('child'))
    expect(await screen.findByText('inside.txt')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Back to parent folder'))

    expect(await screen.findByText('child')).toBeInTheDocument()
    expect(mockToggleDirectory).not.toHaveBeenCalledWith('C:')
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
})
