import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FileExplorer } from './FileExplorer'

const mockToggleDirectory = vi.fn()
const mockRefreshDirectory = vi.fn()
const mockSetRootLoadError = vi.fn()

const mockExplorerState = {
  rootPath: null as string | null,
  directoryContents: new Map<string, Array<{ path: string; name: string; type: 'file' | 'directory' }>>(),
  isVisible: true,
  rootLoadError: null as null | { message: string; code?: string }
}

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorer: () => mockExplorerState,
  useFileExplorerActions: () => ({
    toggleDirectory: mockToggleDirectory,
    selectPath: vi.fn(),
    collapseAll: vi.fn(),
    refreshDirectory: mockRefreshDirectory,
    setRootLoadError: mockSetRootLoadError
  }),
  useFileExplorerStore: {
    getState: vi.fn(() => ({
      expandedDirs: new Set<string>(),
      selectedPath: null,
      loadingDirs: new Set<string>()
    }))
  }
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: vi.fn(() => ({
      openFile: vi.fn(),
      openFiles: new Map(),
      closeFile: vi.fn()
    }))
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: vi.fn(() => ({
      addEditorTab: vi.fn(),
      setActiveTab: vi.fn(),
      removeTab: vi.fn()
    }))
  },
  editorTabId: (path: string) => 'edit-' + path
}))

vi.mock('@/components/file-explorer/FileTreeNode', () => ({
  FileTreeNodeWrapper: ({ entry }: { entry: { name: string } }) => (
    <div data-testid="tree-node">{entry.name}</div>
  )
}))

vi.mock('@/components/file-explorer/FileTreeContextMenu', () => ({
  FileTreeContextMenu: () => null
}))

beforeEach(() => {
  mockToggleDirectory.mockReset()
  mockRefreshDirectory.mockReset()
  mockSetRootLoadError.mockReset()
  mockExplorerState.rootPath = null
  mockExplorerState.directoryContents = new Map()
  mockExplorerState.rootLoadError = null
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

    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('index.ts')).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
  })
})
