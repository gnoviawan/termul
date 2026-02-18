import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useEditorPersistence } from './use-editor-persistence'

const mockPersistenceRead = vi.fn()
const mockPersistenceWriteDebounced = vi.fn()

const mockEditorState = {
  openFiles: new Map(),
  activeFilePath: null as string | null,
  clearAllFiles: vi.fn(),
  openFile: vi.fn().mockResolvedValue(undefined),
  updateCursorPosition: vi.fn(),
  updateScrollTop: vi.fn(),
  setViewMode: vi.fn(),
  updateContent: vi.fn(),
  setActiveFilePath: vi.fn()
}

const mockExplorerState = {
  expandedDirs: new Set<string>(),
  isVisible: true,
  setVisible: vi.fn(),
  setExpandedDirs: vi.fn(),
  restoreExpandedDirs: vi.fn().mockResolvedValue(undefined)
}

const mockWorkspaceState = {
  root: {
    type: 'leaf',
    id: 'pane-root',
    tabs: [],
    activeTabId: null as string | null
  },
  activePaneId: 'pane-root',
  activeTabId: null as string | null,
  clearEditorTabs: vi.fn(),
  syncEditorTabs: vi.fn()
}

const mockProjectState = {
  projects: [
    { id: 'project-a', path: '/projects/a' },
    { id: 'project-b', path: '/projects/b' }
  ]
}

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: vi.fn(() => mockEditorState),
    subscribe: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorerStore: {
    getState: vi.fn(() => mockExplorerState),
    subscribe: vi.fn(() => vi.fn())
  }
}))

vi.mock('@/stores/workspace-store', async () => {
  const actual = await vi.importActual<typeof import('@/stores/workspace-store')>('@/stores/workspace-store')
  return {
    ...actual,
    useWorkspaceStore: {
      getState: vi.fn(() => mockWorkspaceState),
      subscribe: vi.fn(() => vi.fn())
    }
  }
})

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => mockProjectState)
  }
}))

beforeEach(() => {
  mockPersistenceRead.mockReset()
  mockPersistenceWriteDebounced.mockReset()
  mockEditorState.clearAllFiles.mockReset()
  mockWorkspaceState.clearEditorTabs.mockReset()
  mockWorkspaceState.syncEditorTabs.mockReset()
  mockExplorerState.setVisible.mockReset()
  mockExplorerState.setExpandedDirs.mockReset()
  mockExplorerState.restoreExpandedDirs.mockReset()
  mockExplorerState.restoreExpandedDirs.mockResolvedValue(undefined)

  vi.stubGlobal('api', {
    persistence: {
      read: mockPersistenceRead,
      writeDebounced: mockPersistenceWriteDebounced
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useEditorPersistence', () => {
  it('restores only expanded dirs within active project root', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: ['/projects/a', '/projects/a/src', '/projects/b/src', '/outside/path'],
        fileExplorerVisible: true,
        activeTabId: null
      }
    })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockExplorerState.setExpandedDirs).toHaveBeenCalledWith(
        new Set(['/projects/a', '/projects/a/src'])
      )
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenCalledWith([
        '/projects/a',
        '/projects/a/src'
      ])
    })
  })

  it('keeps expanded dir persistence isolated per project', async () => {
    mockPersistenceRead
      .mockResolvedValueOnce({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/a/src'],
          fileExplorerVisible: true,
          activeTabId: null
        }
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/b/docs'],
          fileExplorerVisible: true,
          activeTabId: null
        }
      })

    const { rerender } = renderHook(({ projectId }) => useEditorPersistence(projectId), {
      initialProps: { projectId: 'project-a' }
    })

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenCalledWith(['/projects/a/src'])
    })

    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenCalledWith(['/projects/b/docs'])
    })
  })
})
