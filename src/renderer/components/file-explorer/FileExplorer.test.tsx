import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const mockOpenFile = vi.fn()
const mockCloseFile = vi.fn()
const mockSetViewMode = vi.fn()
const mockUpdateCursorPosition = vi.fn()
const mockAddEditorTab = vi.fn()
const mockRemoveTab = vi.fn()

const mockExplorerState = {
  rootPath: null as string | null,
  directoryContents: new Map<string, Array<{ path: string; name: string; type: 'file' | 'directory' }>>(),
  isVisible: true,
  rootLoadError: null as null | { message: string; code?: string },
  selectedPaths: new Set<string>(),
  clipboard: null,
  searchQuery: '',
  searchResults: [] as Array<{
    filePath: string
    matches: Array<{ lineNumber: number; lineText: string }>
  }>,
  searchFileNameMatches: [] as string[],
  searchLoading: false,
  searchError: null as string | null,
  searchTruncated: false,
  searchScannedFiles: 0,
  searchFailedFiles: 0,
  searchLastCompletedQuery: ''
}

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorer: () => mockExplorerState,
  useFileExplorerActions: () => ({
    toggleDirectory: mockToggleDirectory,
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
    setRootLoadError: mockSetRootLoadError,
    setSearchQuery: mockSetSearchQuery,
    searchInRoot: mockSearchInRoot,
    resetSearch: mockResetSearch
  }),
  useFileExplorerStore: {
    getState: vi.fn(() => ({
      expandedDirs: new Set<string>(),
      selectedPath: null,
      loadingDirs: new Set<string>(),
      lastClickedPath: null,
      clearSelection: mockClearSelection
    })),
    setState: vi.fn()
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
  editorTabId: (path: string) => 'edit-' + path
}))

vi.mock('./FileTreeNode', () => ({
  FileTreeNodeWrapper: ({ entry }: { entry: { name: string } }) => (
    <div data-testid="tree-node">{entry.name}</div>
  )
}))

vi.mock('./FileTreeContextMenu', () => ({
  FileTreeContextMenu: () => null
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockOpenFile.mockResolvedValue(undefined)
  mockExplorerState.rootPath = null
  mockExplorerState.directoryContents = new Map()
  mockExplorerState.isVisible = true
  mockExplorerState.rootLoadError = null
  mockExplorerState.selectedPaths = new Set<string>()
  mockExplorerState.clipboard = null
  mockExplorerState.searchQuery = ''
  mockExplorerState.searchResults = []
  mockExplorerState.searchFileNameMatches = []
  mockExplorerState.searchLoading = false
  mockExplorerState.searchError = null
  mockExplorerState.searchTruncated = false
  mockExplorerState.searchScannedFiles = 0
  mockExplorerState.searchFailedFiles = 0
  mockExplorerState.searchLastCompletedQuery = ''
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
      ['/project', [
        { path: '/project/src', name: 'src', type: 'directory' },
        { path: '/project/index.ts', name: 'index.ts', type: 'file' }
      ]]
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
    expect(screen.getByText('Type at least 2 characters to search file names and content.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()
    expect(screen.getAllByTestId('tree-node').length).toBeGreaterThan(0)
  })

  it('renders search tabs and grouped content results with compact hierarchy', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [{
      filePath: '/project/src/FileExplorer.tsx',
      matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
    }]
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
    mockExplorerState.searchResults = [{
      filePath: '/project/src/FileExplorer.tsx',
      matches: [{ lineNumber: 27, lineText: 'const term = createExplorerSearch();' }]
    }]

    render(<FileExplorer />)

    await act(async () => {
      fireEvent.click(screen.getByText(/createExplorerSearch\(\)/))
      window.dispatchEvent(new Event('load'))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(mockSelectPath).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockOpenFile).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockAddEditorTab).toHaveBeenCalledWith('/project/src/FileExplorer.tsx')
      expect(mockUpdateCursorPosition).toHaveBeenCalledWith('/project/src/FileExplorer.tsx', 27, 1)
      expect((window as unknown as { __termulPendingRevealLine?: { filePath: string; lineNumber: number; searchTerm?: string } }).__termulPendingRevealLine).toEqual({
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
    expect(screen.getByText('Try a different term or a shorter phrase to broaden the search.')).toBeInTheDocument()
    expect(screen.getByText('Results were truncated for performance. 3 files were skipped. Scanned 42 files.')).toBeInTheDocument()
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
    mockExplorerState.searchResults = [{
      filePath: '/project/src/FileExplorer.tsx',
      matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
    }]
    mockExplorerState.searchFileNameMatches = ['/project/src/term-search.ts']
    mockExplorerState.searchLoading = true

    render(<FileExplorer />)

    expect(screen.getByText('Searching for “terminal”…')).toBeInTheDocument()
    expect(screen.getByText('Finishing the latest search before showing refreshed matches.')).toBeInTheDocument()
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
    mockExplorerState.searchResults = [{
      filePath: '/project/src/FileExplorer.tsx',
      matches: [{ lineNumber: 12, lineText: 'const term = createExplorerSearch();' }]
    }]

    render(<FileExplorer />)

    expect(screen.getByText('Partial results for “term”')).toBeInTheDocument()
    expect(screen.getByText('Some files timed out Showing the matches that were found before the search stopped.')).toBeInTheDocument()
    expect(screen.getByText('FileExplorer.tsx')).toBeInTheDocument()
  })

  it('shows only the first three content hits until expanded', () => {
    mockExplorerState.rootPath = '/project'
    mockExplorerState.directoryContents = new Map([['/project', []]])
    mockExplorerState.searchQuery = 'term'
    mockExplorerState.searchLastCompletedQuery = 'term'
    mockExplorerState.searchResults = [{
      filePath: '/project/src/FileExplorer.tsx',
      matches: [
        { lineNumber: 10, lineText: 'term first' },
        { lineNumber: 11, lineText: 'term second' },
        { lineNumber: 12, lineText: 'term third' },
        { lineNumber: 13, lineText: 'term fourth' }
      ]
    }]

    render(<FileExplorer />)

    expect(screen.getByText('Show 1 more')).toBeInTheDocument()
    expect(screen.queryByText('term fourth')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))

    expect(screen.getByText((_, element) => element?.textContent === 'term fourth')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })
})
