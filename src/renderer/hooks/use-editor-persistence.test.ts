import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useEditorPersistence, persistState } from './use-editor-persistence'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { PaneNode, SplitNode } from '@/types/workspace.types'

const mockPersistenceRead = vi.fn()
const mockPersistenceWriteDebounced = vi.fn()

function createEditorFileState(filePath: string): {
  filePath: string
  content: string
  originalContent: string
  isDirty: boolean
  language: string
  lastModified: number
  viewMode: 'code' | 'markdown'
  cursorPosition: { line: number; col: number }
  scrollTop: number
} {
  return {
    filePath,
    content: '',
    originalContent: '',
    isDirty: false,
    language: 'typescript',
    lastModified: Date.now(),
    viewMode: 'code',
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0
  }
}

const mockEditorState = {
  openFiles: new Map<string, ReturnType<typeof createEditorFileState>>(),
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

const mockWorkspaceState: {
  root: PaneNode
  activePaneId: string
  activeTabId: string | null
  syncEditorTabs: ReturnType<typeof vi.fn>
  remapTerminalTabs: ReturnType<typeof vi.fn>
  syncTerminalTabs: ReturnType<typeof vi.fn>
  clearEditorTabs: ReturnType<typeof vi.fn>
  resetLayout: ReturnType<typeof vi.fn>
} = {
  root: {
    type: 'leaf',
    id: 'pane-root',
    tabs: [],
    activeTabId: null
  },
  activePaneId: 'pane-root',
  activeTabId: null,
  syncEditorTabs: vi.fn(),
  remapTerminalTabs: vi.fn(),
  syncTerminalTabs: vi.fn(),
  clearEditorTabs: vi.fn(),
  resetLayout: vi.fn()
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
  const actual = await vi.importActual<typeof import('@/stores/workspace-store')>(
    '@/stores/workspace-store'
  )
  return {
    ...actual,
    useWorkspaceStore: {
      getState: vi.fn(() => mockWorkspaceState),
      setState: vi.fn(),
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

  mockEditorState.openFiles = new Map<string, ReturnType<typeof createEditorFileState>>()
  mockEditorState.activeFilePath = null
  mockEditorState.clearAllFiles.mockReset()
  mockEditorState.clearAllFiles.mockImplementation(() => {
    mockEditorState.openFiles.clear()
    mockEditorState.activeFilePath = null
  })
  mockEditorState.openFile.mockReset()
  mockEditorState.openFile.mockImplementation(async (filePath: string) => {
    mockEditorState.openFiles.set(filePath, createEditorFileState(filePath))
  })
  mockEditorState.updateCursorPosition.mockReset()
  mockEditorState.updateScrollTop.mockReset()
  mockEditorState.setViewMode.mockReset()
  mockEditorState.updateContent.mockReset()
  mockEditorState.setActiveFilePath.mockReset()

  mockExplorerState.expandedDirs = new Set<string>()
  mockExplorerState.isVisible = true
  mockExplorerState.setVisible.mockReset()
  mockExplorerState.setExpandedDirs.mockReset()
  mockExplorerState.restoreExpandedDirs.mockReset()
  mockExplorerState.restoreExpandedDirs.mockResolvedValue(undefined)

  mockWorkspaceState.root = {
    type: 'leaf',
    id: 'pane-root',
    tabs: [],
    activeTabId: null
  }
  mockWorkspaceState.activePaneId = 'pane-root'
  mockWorkspaceState.activeTabId = null
  mockWorkspaceState.syncEditorTabs.mockReset()
  mockWorkspaceState.remapTerminalTabs.mockReset()
  mockWorkspaceState.syncTerminalTabs.mockReset()
  mockWorkspaceState.clearEditorTabs.mockReset()
  mockWorkspaceState.resetLayout.mockReset()

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

  it('persists pane layout with mixed editor and terminal tabs', () => {
    mockEditorState.openFiles.set('/projects/a/src/index.ts', createEditorFileState('/projects/a/src/index.ts'))
    mockEditorState.openFiles.set('/projects/a/README.md', createEditorFileState('/projects/a/README.md'))
    mockEditorState.activeFilePath = '/projects/a/src/index.ts'
    mockExplorerState.expandedDirs = new Set(['/projects/a', '/projects/a/src'])

    mockWorkspaceState.root = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [55, 45],
      children: [
        {
          type: 'leaf',
          id: 'pane-left',
          tabs: [
            { type: 'terminal', id: 'term-old-1', terminalId: 'old-1' },
            {
              type: 'editor',
              id: 'edit-/projects/a/src/index.ts',
              filePath: '/projects/a/src/index.ts'
            }
          ],
          activeTabId: 'term-old-1'
        },
        {
          type: 'leaf',
          id: 'pane-right',
          tabs: [
            {
              type: 'editor',
              id: 'edit-/projects/a/README.md',
              filePath: '/projects/a/README.md'
            }
          ],
          activeTabId: 'edit-/projects/a/README.md'
        }
      ]
    }
    mockWorkspaceState.activePaneId = 'pane-left'

    persistState('project-a')

    expect(mockPersistenceWriteDebounced).toHaveBeenCalledTimes(1)
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      'editor-state/project-a',
      expect.objectContaining({
        activePaneId: 'pane-left',
        paneLayout: expect.objectContaining({
          type: 'split',
          id: 'split-root',
          direction: 'horizontal'
        })
      })
    )

    const payload = mockPersistenceWriteDebounced.mock.calls[0][1]
    const leftLeaf = payload.paneLayout.children[0]
    expect(leftLeaf.tabs).toEqual([
      { type: 'terminal', terminalId: 'old-1' },
      { type: 'editor', filePath: '/projects/a/src/index.ts' }
    ])
  })

  it('restores pane layout, keeps terminal tabs, and prunes missing editor tabs', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [
          {
            filePath: '/projects/a/src/existing.ts',
            cursorPosition: { line: 1, col: 1 },
            scrollTop: 0,
            viewMode: 'code',
            isDirty: false,
            lastModified: 10
          }
        ],
        activeFilePath: '/projects/a/src/existing.ts',
        expandedDirs: ['/projects/a/src'],
        fileExplorerVisible: true,
        activeTabId: null,
        activePaneId: 'pane-drop',
        paneLayout: {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-keep',
              tabs: [
                { type: 'terminal', terminalId: 'old-1' },
                { type: 'editor', filePath: '/projects/a/src/existing.ts' }
              ],
              activeTabId: 'term-old-1'
            },
            {
              type: 'leaf',
              id: 'pane-drop',
              tabs: [{ type: 'editor', filePath: '/projects/a/src/missing.ts' }],
              activeTabId: 'edit-/projects/a/src/missing.ts'
            }
          ]
        }
      }
    })

    renderHook(() => useEditorPersistence('project-a'))

    const workspaceStoreSetState = vi.mocked(useWorkspaceStore.setState)

    await waitFor(() => {
      expect(workspaceStoreSetState).toHaveBeenCalled()
    })

    const workspaceStateUpdate = workspaceStoreSetState.mock.calls
      .map((call) => call[0])
      .find((arg) => arg && typeof arg === 'object' && 'root' in arg)

    expect(workspaceStateUpdate).toBeTruthy()
    if (!workspaceStateUpdate) throw new Error('workspaceStateUpdate is undefined')

    expect(workspaceStateUpdate.activePaneId).toBe('pane-drop')

    const restoredRoot = workspaceStateUpdate.root as SplitNode
    expect(restoredRoot.type).toBe('split')

    const leftLeaf = restoredRoot.children[0]
    const rightLeaf = restoredRoot.children[1]

    expect(leftLeaf.type).toBe('leaf')
    expect(leftLeaf.id).toBe('pane-keep')
    expect(leftLeaf.tabs).toEqual([
      { type: 'terminal', id: 'term-old-1', terminalId: 'old-1' },
      {
        type: 'editor',
        id: 'edit-/projects/a/src/existing.ts',
        filePath: '/projects/a/src/existing.ts'
      }
    ])

    expect(rightLeaf.type).toBe('leaf')
    expect(rightLeaf.id).toBe('pane-drop')
    expect(rightLeaf.tabs).toEqual([])
  })

  it('restores legacy pane layout entries that use editorFilePaths', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [
          {
            filePath: '/projects/a/src/legacy.ts',
            cursorPosition: { line: 1, col: 1 },
            scrollTop: 0,
            viewMode: 'code',
            isDirty: false,
            lastModified: 10
          }
        ],
        activeFilePath: '/projects/a/src/legacy.ts',
        expandedDirs: ['/projects/a/src'],
        fileExplorerVisible: true,
        activeTabId: null,
        activePaneId: 'pane-legacy',
        paneLayout: {
          type: 'leaf',
          id: 'pane-legacy',
          editorFilePaths: ['/projects/a/src/legacy.ts'],
          activeTabId: 'edit-/projects/a/src/legacy.ts'
        }
      }
    })

    renderHook(() => useEditorPersistence('project-a'))

    const workspaceStoreSetState = vi.mocked(useWorkspaceStore.setState)

    await waitFor(() => {
      expect(workspaceStoreSetState).toHaveBeenCalled()
    })

    const workspaceStateUpdate = workspaceStoreSetState.mock.calls
      .map((call) => call[0])
      .find((arg) => arg && typeof arg === 'object' && 'root' in arg)

    expect(workspaceStateUpdate).toBeTruthy()
    if (!workspaceStateUpdate) throw new Error('workspaceStateUpdate is undefined')

    expect(workspaceStateUpdate.activePaneId).toBe('pane-legacy')
    expect(workspaceStateUpdate.root).toEqual({
      type: 'leaf',
      id: 'pane-legacy',
      tabs: [
        {
          type: 'editor',
          id: 'edit-/projects/a/src/legacy.ts',
          filePath: '/projects/a/src/legacy.ts'
        }
      ],
      activeTabId: 'edit-/projects/a/src/legacy.ts'
    })
  })

  it('resets pane layout when destination project has no persisted state', async () => {
    mockWorkspaceState.root = {
      type: 'split',
      id: 'split-old',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'pane-left',
          tabs: [
            { type: 'terminal', id: 'term-old-1', terminalId: 'old-1' }
          ],
          activeTabId: 'term-old-1'
        },
        {
          type: 'leaf',
          id: 'pane-right',
          tabs: [
            {
              type: 'editor',
              id: 'edit-/projects/a/src/leftover.ts',
              filePath: '/projects/a/src/leftover.ts'
            }
          ],
          activeTabId: 'edit-/projects/a/src/leftover.ts'
        }
      ]
    }
    mockWorkspaceState.activePaneId = 'pane-left'

    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: null
    })

    renderHook(() => useEditorPersistence('project-b'))

    await waitFor(() => {
      expect(mockWorkspaceState.resetLayout).toHaveBeenCalledTimes(1)
    })
  })
})
