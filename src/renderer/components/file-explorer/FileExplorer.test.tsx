import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type FileExplorerState, useFileExplorerStore } from '@/stores/file-explorer-store'
import { FileExplorer } from './FileExplorer'

const mockToggleDirectory = vi.fn()
const mockSelectPath = vi.fn()
const mockTogglePathSelection = vi.fn()
const mockSelectPathRange = vi.fn()
const mockSelectAll = vi.fn()
const mockClearSelection = vi.fn()
const mockCopySelected = vi.fn()
const mockCutSelected = vi.fn()
const mockPaste = vi.fn()
const mockDuplicateSelected = vi.fn()
const mockCollapseAll = vi.fn()
const mockRefreshDirectory = vi.fn()
const mockSetRootLoadError = vi.fn()
const mockSetSearchQuery = vi.fn()
const mockSearchInRoot = vi.fn()
const mockResetSearch = vi.fn()

const mockSearchFileNamesStreamCancel = vi
  .fn()
  .mockResolvedValue({ success: true, data: undefined })
const mockSearchContentStreamCancel = vi.fn().mockResolvedValue({ success: true, data: undefined })

const mockOpenFile = vi.fn()
const mockCloseFile = vi.fn()
const mockSetViewMode = vi.fn()
const mockUpdateCursorPosition = vi.fn()
const mockAddEditorTab = vi.fn()
const mockRemoveTab = vi.fn()

const mockCreateFile = vi.fn()
const mockCreateDirectory = vi.fn()
const mockRenameFile = vi.fn()
const mockRefreshTree = vi.fn().mockResolvedValue(undefined)

const mockExplorerState = {
  rootPath: null as string | null,
  directoryContents: new Map<
    string,
    Array<{ path: string; name: string; type: 'file' | 'directory' }>
  >(),
  isVisible: true,
  rootLoadError: null as null | { message: string; code?: string },
  selectedPaths: new Set<string>(),
  clipboard: null as null | { action: 'copy' | 'cut'; paths: string[] },
  searchQuery: '',
  searchResults: [] as Array<{
    filePath: string
    matches: Array<{ lineNumber: number; lineText: string }>
  }>,
  searchFileNameMatches: [] as string[] | null,
  searchLoading: false,
  searchError: null as string | null,
  searchTruncated: false,
  searchScannedFiles: 0,
  searchFailedFiles: 0,
  searchLastCompletedQuery: ''
}

/** Live object returned by the mocked useFileExplorerStore.getState(). */
const mockStoreGetState = {
  expandedDirs: new Set<string>(),
  selectedPaths: new Set<string>(),
  loadingDirs: new Set<string>(),
  lastClickedPath: null as string | null,
  rootPath: null as string | null,
  clearSelection: mockClearSelection
}

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorer: () => mockExplorerState,
  useFileExplorerActions: () => ({
    toggleDirectory: (...args: unknown[]) => mockToggleDirectory(...args),
    selectPath: mockSelectPath,
    togglePathSelection: mockTogglePathSelection,
    selectPathRange: mockSelectPathRange,
    selectAll: mockSelectAll,
    clearSelection: mockClearSelection,
    copySelected: mockCopySelected,
    cutSelected: mockCutSelected,
    paste: mockPaste,
    duplicateSelected: mockDuplicateSelected,
    collapseAll: mockCollapseAll,
    refreshDirectory: mockRefreshDirectory,
    refreshTree: mockRefreshTree,
    setRootLoadError: mockSetRootLoadError,
    setSearchQuery: mockSetSearchQuery,
    searchInRoot: mockSearchInRoot,
    resetSearch: mockResetSearch
  }),
  useFileExplorerStore: {
    getState: vi.fn(() => mockStoreGetState),
    setState: vi.fn()
  }
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    searchFileNamesStreamCancel: (...args: unknown[]) => mockSearchFileNamesStreamCancel(...args),
    searchContentStreamCancel: (...args: unknown[]) => mockSearchContentStreamCancel(...args),
    createFile: (...args: unknown[]) => mockCreateFile(...args),
    createDirectory: (...args: unknown[]) => mockCreateDirectory(...args),
    renameFile: (...args: unknown[]) => mockRenameFile(...args)
  }
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: vi.fn(() => ({
      openFile: mockOpenFile,
      openFiles: new Map(),
      closeFile: mockCloseFile,
      setViewMode: mockSetViewMode,
      updateCursorPosition: mockUpdateCursorPosition
    }))
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: vi.fn(() => ({
      addEditorTab: mockAddEditorTab,
      setActiveTab: vi.fn(),
      removeTab: mockRemoveTab
    }))
  },
  editorTabId: (path: string) => `edit-${path}`
}))

vi.mock('./FileTreeNode', () => ({
  FileTreeNodeWrapper: ({ entry }: { entry: { name: string } }) => (
    <div data-testid="tree-node">{entry.name}</div>
  )
}))

vi.mock('./FileTreeContextMenu', () => ({
  FileTreeContextMenuContent: () => null
}))

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps per-test mockReturnValue overrides; restore the
  // default store-state implementation for every test.
  vi.mocked(useFileExplorerStore.getState).mockImplementation(() => mockStoreGetState)
  mockOpenFile.mockResolvedValue(undefined)
  mockCreateFile.mockResolvedValue({ success: true, data: undefined })
  mockCreateDirectory.mockResolvedValue({ success: true, data: undefined })
  mockRenameFile.mockResolvedValue({ success: true, data: undefined })
  mockRefreshTree.mockResolvedValue(undefined)
  // Expanding a directory marks it expanded in the mocked store state so
  // expand-chain guards (GH-539/GH-540) observe the toggle's effect.
  mockToggleDirectory.mockImplementation(async (dirPath: string) => {
    mockStoreGetState.expandedDirs.add(dirPath)
  })
  mockStoreGetState.expandedDirs = new Set<string>()
  mockStoreGetState.selectedPaths = new Set<string>()
  mockStoreGetState.loadingDirs = new Set<string>()
  mockStoreGetState.lastClickedPath = null
  mockStoreGetState.rootPath = null
  mockExplorerState.rootPath = null
  mockExplorerState.directoryContents = new Map()
  mockExplorerState.isVisible = true
  mockExplorerState.rootLoadError = null
  mockExplorerState.selectedPaths = new Set<string>()
  mockExplorerState.clipboard = null
  mockExplorerState.searchQuery = ''
  mockExplorerState.searchResults = []
  mockExplorerState.searchFileNameMatches = null
  mockExplorerState.searchLoading = false
  mockExplorerState.searchError = null
  mockExplorerState.searchTruncated = false
  mockExplorerState.searchScannedFiles = 0
  mockExplorerState.searchFailedFiles = 0
  mockExplorerState.searchLastCompletedQuery = ''
  delete (window as unknown as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine
})

describe('FileExplorer', () => {
  it('shows loading while root entries are unavailable', () => {
    mockExplorerState.rootPath = '/project'

    render(<FileExplorer />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows root error state and retry action', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.rootLoadError = { message: 'Permission denied', code: 'PERMISSION_DENIED' }

    render(<FileExplorer />)

    expect(screen.getByText('Failed to load project files.')).toBeInTheDocument()
    expect(screen.getByText('Permission denied')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('retries root loading when retry is clicked', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.rootLoadError = { message: 'Permission denied', code: 'PERMISSION_DENIED' }

    render(<FileExplorer />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(mockSetRootLoadError).toHaveBeenCalledWith(null)
    expect(mockToggleDirectory).toHaveBeenCalledWith('/project')
  })

  it('renders tree nodes once root entries are available', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([
      [
        '/project',
        [
          { path: '/project/src', name: 'src', type: 'directory' },
          { path: '/project/index.ts', name: 'index.ts', type: 'file' }
        ]
      ]
    ])

    render(<FileExplorer />)

    expect(screen.getAllByText('src')).not.toHaveLength(0)
    expect(screen.getAllByText('index.ts')).not.toHaveLength(0)
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })

  it('renders the refreshed search helper state for short queries while keeping the tree visible', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([
      ['/project', [{ path: '/project/src', name: 'src', type: 'directory' }]]
    ])
    mockExplorerState.searchQuery = 'a'

    render(<FileExplorer />)

    expect(screen.getByLabelText('Search files and content')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Search files and content…')).toBeInTheDocument()
    expect(screen.getByText('Keep typing to start searching')).toBeInTheDocument()
    expect(
      screen.getByText('Type at least 2 characters to search file names and content.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
    expect(screen.getAllByTestId('tree-node').length).toBeGreaterThan(0)
  })

  it('renders search tabs and grouped content results with compact hierarchy', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
      }
    ]
    mockExplorerState.searchFileNameMatches = ['/project/src/term-search.ts']

    render(<FileExplorer />)

    expect(screen.getByRole('tab', { name: /Content 1/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Files 1/i })).toBeInTheDocument()
    expect(screen.getByText('FileExplorer.tsx')).toBeInTheDocument()
    expect(screen.getByText('src/FileExplorer.tsx')).toBeInTheDocument()
    expect(screen.getByText(/createExplorerSearch\(\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Files 1/i }))

    expect(screen.getByRole('tab', { name: /Files 1/i })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('term-search.ts')).toBeInTheDocument()
  })

  it('shows the Files tab with an ellipsis while filename matches are still pending', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
      }
    ]
    mockExplorerState.searchFileNameMatches = null

    render(<FileExplorer />)

    expect(screen.getByRole('tab', { name: /Files …/i })).toBeInTheDocument()
  })

  it('replaces the pending indicator with the streamed count once matches arrive', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
      }
    ]
    mockExplorerState.searchFileNameMatches = null

    const { rerender } = render(<FileExplorer />)
    expect(screen.getByRole('tab', { name: /Files …/i })).toBeInTheDocument()

    mockExplorerState.searchFileNameMatches = ['/project/src/term-search.ts']
    rerender(<FileExplorer />)

    expect(screen.getByRole('tab', { name: /Files 1/i })).toBeInTheDocument()
  })

  it('opens file-name search results with existing editor behavior', async () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchFileNameMatches = ['/project/src/term-search.ts']

    render(<FileExplorer />)

    fireEvent.click(screen.getByText('term-search.ts').closest('button')!)

    await waitFor(() => {
      expect(mockSelectPath).toHaveBeenCalledWith('/project/src/term-search.ts')
      expect(mockOpenFile).toHaveBeenCalledWith('/project/src/term-search.ts')
      expect(mockAddEditorTab).toHaveBeenCalledWith('/project/src/term-search.ts')
      expect(mockUpdateCursorPosition).toHaveBeenCalledWith('/project/src/term-search.ts', 1, 1)
    })
  })

  it('opens content search matches at the matched line', async () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 27, lineText: 'const term = createExplorerSearch();' }]
      }
    ]

    render(<FileExplorer />)

    await act(async () => {
      fireEvent.click(screen.getByText(/createExplorerSearch\(\)/))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockSelectPath).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockOpenFile).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockAddEditorTab).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockUpdateCursorPosition).toHaveBeenCalledWith('/project/src/FileExplorer.tsx', 27, 1)
      expect(
        (
          window as unknown as {
            __termulPendingRevealLine?: {
              filePath: string
              lineNumber: number
              searchTerm?: string
            }
          }
        ).__termulPendingRevealLine
      ).toEqual({
        filePath: '/project/src/FileExplorer.tsx',
        lineNumber: 27,
        searchTerm: 'term'
      })
    })
  })

  it('renders empty and degraded search states clearly', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchTruncated = true
    mockExplorerState.searchScannedFiles = 42
    mockExplorerState.searchFailedFiles = 3

    render(<FileExplorer />)

    expect(screen.getByText('No matches for “term”')).toBeInTheDocument()
    expect(
      screen.getByText('Try a different term or a shorter phrase to broaden the search.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Results were truncated for performance. 3 files were skipped. Scanned 42 files.'
      )
    ).toBeInTheDocument()
  })

  it('renders loading and error search states', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLoading = true

    const { rerender } = render(<FileExplorer />)

    expect(screen.getByText('Searching for “term”…')).toBeInTheDocument()

    mockExplorerState.searchLoading = false
    mockExplorerState.searchError = 'ripgrep unavailable'
    rerender(<FileExplorer />)

    expect(screen.getByText('Search unavailable')).toBeInTheDocument()
    expect(screen.getByText('ripgrep unavailable')).toBeInTheDocument()
  })

  it('keeps tabs visible and selectable while loading continues', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'terminal'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
      }
    ]
    mockExplorerState.searchFileNameMatches = ['/project/src/term-search.ts']
    mockExplorerState.searchLoading = true

    render(<FileExplorer />)

    expect(screen.getByText('Searching for “terminal”…')).toBeInTheDocument()
    expect(
      screen.getByText('Finishing the latest search before showing refreshed matches.')
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Content 1/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Files 1/i }))

    expect(screen.getByRole('tab', { name: /Files 1/i })).toHaveAttribute('aria-selected', 'true')
  })

  it('surfaces partial-error messaging alongside current results', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchError = 'Some files timed out'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
      }
    ]

    render(<FileExplorer />)

    expect(screen.getByText('Partial results for “term”')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Some files timed out Showing the matches that were found before the search stopped.'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('FileExplorer.tsx')).toBeInTheDocument()
  })

  it('does not show expand/collapse controls when a file has exactly three matches', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/ThreeMatches.tsx',
        matches: [
          { lineNumber: 10, lineText: 'term first' },
          { lineNumber: 11, lineText: 'term second' },
          { lineNumber: 12, lineText: 'term third' }
        ]
      }
    ]

    render(<FileExplorer />)

    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument()
  })

  it('shows only the first three content hits until expanded', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [
      {
        filePath: '/project/src/FileExplorer.tsx',
        matches: [
          { lineNumber: 10, lineText: 'term first' },
          { lineNumber: 11, lineText: 'term second' },
          { lineNumber: 12, lineText: 'term third' },
          { lineNumber: 13, lineText: 'term fourth' }
        ]
      }
    ]

    render(<FileExplorer />)

    expect(screen.getByText('Show 1 more')).toBeInTheDocument()
    expect(screen.queryByText('term fourth')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))

    expect(
      screen.getByText((_, element) => element?.textContent === 'term fourth')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('cancels in-flight filename and content streams on unmount with the active searchId', () => {
    // The unmount cleanup must fire the cancel IPC for both the filename
    // and the content stream, scoped to the searchId that was active at
    // effect setup time (not at cleanup time, in case the store id
    // changed via a different code path between setup and unmount).
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'

    // Mock getState to return searchRequestId = 5
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      searchRequestId: 5,
      expandedDirs: new Set<string>(),
      selectedPaths: new Set<string>(),
      loadingDirs: new Set<string>(),
      lastClickedPath: null,
      clearSelection: vi.fn()
    } as unknown as FileExplorerState)

    const { unmount } = render(<FileExplorer />)
    mockSearchFileNamesStreamCancel.mockClear()
    mockSearchContentStreamCancel.mockClear()

    // The id was captured at setup; even if the store value changes before
    // unmount, the cleanup must still use the captured id.
    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      searchRequestId: 99, // would-be new id, but cleanup should ignore
      expandedDirs: new Set<string>(),
      selectedPaths: new Set<string>(),
      loadingDirs: new Set<string>(),
      lastClickedPath: null,
      clearSelection: vi.fn()
    } as unknown as FileExplorerState)

    unmount()

    expect(mockSearchFileNamesStreamCancel).toHaveBeenCalledTimes(1)
    expect(mockSearchFileNamesStreamCancel).toHaveBeenCalledWith('search-5')
    expect(mockSearchContentStreamCancel).toHaveBeenCalledTimes(1)
    expect(mockSearchContentStreamCancel).toHaveBeenCalledWith('search-5')
  })

  it('does not call cancel on unmount when no search is in flight', () => {
    // When searchRequestId is 0 (no search), the unmount effect's id > 0
    // guard must short-circuit so we do not issue a cancel for `search-0`.
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = ''

    vi.mocked(useFileExplorerStore.getState).mockReturnValue({
      searchRequestId: 0,
      expandedDirs: new Set<string>(),
      selectedPaths: new Set<string>(),
      loadingDirs: new Set<string>(),
      lastClickedPath: null,
      clearSelection: vi.fn()
    } as unknown as FileExplorerState)

    const { unmount } = render(<FileExplorer />)
    mockSearchFileNamesStreamCancel.mockClear()
    mockSearchContentStreamCancel.mockClear()

    unmount()

    expect(mockSearchFileNamesStreamCancel).not.toHaveBeenCalled()
    expect(mockSearchContentStreamCancel).not.toHaveBeenCalled()
  })
})

describe('FileExplorer header toolbar (GH-540)', () => {
  function setExpandedDirs(expandedDirs: Set<string>): void {
    mockStoreGetState.expandedDirs = expandedDirs
  }

  function setProjectRoot(rootPath: string | null): void {
    mockExplorerState.rootPath = rootPath
    mockStoreGetState.rootPath = rootPath
  }

  function openProjectWithRootEntries(
    entries: Array<{ path: string; name: string; type: 'file' | 'directory' }>
  ): void {
    setProjectRoot('/project')
    mockExplorerState.directoryContents = new Map([['/project', entries]])
  }

  beforeEach(() => {
    setExpandedDirs(new Set(['/project']))
  })

  it('renders all four actions with tooltips and accessible labels', () => {
    openProjectWithRootEntries([])

    render(<FileExplorer />)

    for (const name of ['New File', 'New Folder', 'Refresh', 'Collapse All']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeEnabled()
      expect(button).toHaveAttribute('title', name)
    }
  })

  it('disables every action when no project is open', () => {
    setProjectRoot(null)

    render(<FileExplorer />)

    for (const name of ['New File', 'New Folder', 'Refresh', 'Collapse All']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('starts creation in the project root when nothing is selected', async () => {
    openProjectWithRootEntries([])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'notes.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/notes.txt'))
    await waitFor(() => expect(mockRefreshDirectory).toHaveBeenCalledWith('/project'))
    await waitFor(() => expect(mockSelectPath).toHaveBeenCalledWith('/project/notes.txt'))
  })

  it('creates a folder in the project root when nothing is selected', async () => {
    openProjectWithRootEntries([])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))

    const input = await screen.findByPlaceholderText('Folder name...')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateDirectory).toHaveBeenCalledWith('/project/docs'))
    await waitFor(() => expect(mockSelectPath).toHaveBeenCalledWith('/project/docs'))
  })

  it('targets the selected directory', async () => {
    openProjectWithRootEntries([{ path: '/project/src', name: 'src', type: 'directory' }])
    mockExplorerState.selectedPaths = new Set(['/project/src'])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'main.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/src/main.ts'))
    await waitFor(() => expect(mockSelectPath).toHaveBeenCalledWith('/project/src/main.ts'))
  })

  it('targets the parent directory of the selected file', async () => {
    setProjectRoot('/project')
    mockExplorerState.directoryContents = new Map([
      ['/project', []],
      ['/project/src', [{ path: '/project/src/app.ts', name: 'app.ts', type: 'file' as const }]]
    ])
    mockExplorerState.selectedPaths = new Set(['/project/src/app.ts'])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'util.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/src/util.ts'))
  })

  it('falls back to the project root when multiple entries are selected', async () => {
    openProjectWithRootEntries([{ path: '/project/src', name: 'src', type: 'directory' }])
    mockExplorerState.selectedPaths = new Set(['/project/src', '/project/README.md'])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'top.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/top.md'))
  })

  it('auto-expands unexpanded ancestor directories of the target before creating', async () => {
    setProjectRoot('/project')
    mockExplorerState.directoryContents = new Map([
      ['/project', [{ path: '/project/src', name: 'src', type: 'directory' as const }]],
      ['/project/src', [{ path: '/project/src/deep', name: 'deep', type: 'directory' as const }]]
    ])
    mockExplorerState.selectedPaths = new Set(['/project/src/deep'])
    setExpandedDirs(new Set(['/project']))

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    expect(mockToggleDirectory).toHaveBeenCalledWith('/project/src')
    expect(mockToggleDirectory).toHaveBeenCalledWith('/project/src/deep')
    expect(mockToggleDirectory).not.toHaveBeenCalledWith('/project')

    fireEvent.change(input, { target: { value: 'leaf.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/src/deep/leaf.ts'))
  })

  it('keeps the inline input open when creation fails', async () => {
    openProjectWithRootEntries([])
    mockCreateFile.mockResolvedValueOnce({ success: false, error: 'PERMISSION_DENIED' })

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'blocked.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/blocked.txt'))
    expect(screen.getByPlaceholderText('File name...')).toBeInTheDocument()
    expect(mockSelectPath).not.toHaveBeenCalled()
  })

  it('falls back to the project root when the selected path cannot be resolved', async () => {
    openProjectWithRootEntries([])
    mockExplorerState.selectedPaths = new Set(['/project/stale-entry'])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'fresh.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/fresh.txt'))
  })

  it('does not clobber an active inline input when a header action is clicked again', async () => {
    openProjectWithRootEntries([])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'half-typed' } })

    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))

    // The original create input (and its typed value) must survive.
    const stillOpen = await screen.findByPlaceholderText('File name...')
    expect(stillOpen).toHaveValue('half-typed')
    expect(screen.queryByPlaceholderText('Folder name...')).not.toBeInTheDocument()
  })

  it('rejects invalid names, then accepts a valid name (submission lock released)', async () => {
    openProjectWithRootEntries([])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: '../evil.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).not.toHaveBeenCalled())
    expect(screen.getByPlaceholderText('File name...')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'nested/file.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).not.toHaveBeenCalled())

    // After the rejections the input must still submit successfully.
    fireEvent.change(input, { target: { value: 'ok.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/ok.txt'))
  })

  it('serializes concurrent header creates while expansion is in flight', async () => {
    openProjectWithRootEntries([{ path: '/project/src', name: 'src', type: 'directory' }])
    mockExplorerState.selectedPaths = new Set(['/project/src'])
    setExpandedDirs(new Set(['/project']))

    // Hold the expansion open until the test releases it.
    let releaseToggle: (() => void) | undefined
    mockToggleDirectory.mockImplementationOnce(
      (dirPath: string) =>
        new Promise<void>((resolve) => {
          releaseToggle = () => {
            mockStoreGetState.expandedDirs.add(dirPath)
            resolve()
          }
        })
    )

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))
    // Second click lands while the first chain is still awaiting — must be ignored.
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))

    releaseToggle?.()

    const input = await screen.findByPlaceholderText('File name...')
    expect(input).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Folder name...')).not.toBeInTheDocument()
  })

  it('clamps an out-of-root resolved target to the active project root', async () => {
    setProjectRoot('/project')
    mockExplorerState.directoryContents = new Map([
      ['/project', []],
      ['/elsewhere', [{ path: '/elsewhere/file.ts', name: 'file.ts', type: 'file' as const }]]
    ])
    mockExplorerState.selectedPaths = new Set(['/elsewhere/file.ts'])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'safe.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Creation must land inside the active root, never '/elsewhere'.
    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/project/safe.txt'))
    expect(mockCreateFile).not.toHaveBeenCalledWith('/elsewhere/safe.txt')
  })

  it('creates inside a child of a filesystem-root project without a double slash', async () => {
    setProjectRoot('/')
    mockExplorerState.directoryContents = new Map([
      ['/', [{ path: '/src', name: 'src', type: 'directory' as const }]]
    ])
    mockExplorerState.selectedPaths = new Set(['/src'])
    setExpandedDirs(new Set(['/']))

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'app.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/src/app.ts'))
    expect(mockCreateFile).not.toHaveBeenCalledWith('//src/app.ts')
  })

  it('creates a file directly under a filesystem-root project without a double slash', async () => {
    setProjectRoot('/')
    mockExplorerState.directoryContents = new Map([['/', []]])
    setExpandedDirs(new Set(['/']))

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    const input = await screen.findByPlaceholderText('File name...')
    fireEvent.change(input, { target: { value: 'notes.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateFile).toHaveBeenCalledWith('/notes.txt'))
    expect(mockCreateFile).not.toHaveBeenCalledWith('//notes.txt')
  })

  it('creates a folder directly under a filesystem-root project without a double slash', async () => {
    setProjectRoot('/')
    mockExplorerState.directoryContents = new Map([['/', []]])
    setExpandedDirs(new Set(['/']))

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))

    const input = await screen.findByPlaceholderText('Folder name...')
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockCreateDirectory).toHaveBeenCalledWith('/docs'))
    expect(mockCreateDirectory).not.toHaveBeenCalledWith('//docs')
  })

  it('aborts creation when the target directory cannot be expanded', async () => {
    openProjectWithRootEntries([{ path: '/project/src', name: 'src', type: 'directory' }])
    mockExplorerState.selectedPaths = new Set(['/project/src'])
    // Expansion fails (e.g. load error): the toggle never marks the dir expanded.
    mockToggleDirectory.mockImplementationOnce(async () => {})

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'New File' }))

    await waitFor(() => expect(mockToggleDirectory).toHaveBeenCalledWith('/project/src'))
    expect(screen.queryByPlaceholderText('File name...')).not.toBeInTheDocument()
    expect(mockCreateFile).not.toHaveBeenCalled()
    expect(mockCreateDirectory).not.toHaveBeenCalled()
  })

  it('refresh re-reads the tree without touching inline state', async () => {
    openProjectWithRootEntries([{ path: '/project/src', name: 'src', type: 'directory' }])

    render(<FileExplorer />)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(mockRefreshTree).toHaveBeenCalledTimes(1))
    expect(screen.queryByPlaceholderText('File name...')).not.toBeInTheDocument()
  })

  it('disables header actions while the root failed to load', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.rootLoadError = { message: 'Failed to load' }

    render(<FileExplorer />)

    for (const name of ['New File', 'New Folder', 'Refresh', 'Collapse All']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('does not start a collapse or create action when disabled without a project', () => {
    setProjectRoot(null)

    render(<FileExplorer />)

    fireEvent.click(screen.getByRole('button', { name: 'New File' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse All' }))

    expect(mockCollapseAll).not.toHaveBeenCalled()
    expect(mockToggleDirectory).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('File name...')).not.toBeInTheDocument()
  })
})
