import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import { persistState, useEditorPersistence } from './use-editor-persistence'

const { mockLoadPersistedTerminals } = vi.hoisted(() => ({
  mockLoadPersistedTerminals: vi.fn()
}))

const { mockPersistenceRead, mockPersistenceWriteDebounced } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWriteDebounced: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    writeDebounced: mockPersistenceWriteDebounced
  }
}))

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
  loadProjectWorkspace: ReturnType<typeof vi.fn>
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
  resetLayout: vi.fn(),
  loadProjectWorkspace: vi.fn()
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

const mockTerminalState = {
  terminals: [] as Array<{
    id: string
    name: string
    projectId: string
    shell: string
    cwd?: string
    ptyId?: string
  }>
}

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => mockTerminalState)
  }
}))

vi.mock('./useTerminalAutoSave', () => ({
  loadPersistedTerminals: mockLoadPersistedTerminals
}))

// P11: mock the manifest facade + log facade + sync store so loadWorkspaceManifest
// doesn't hit real network I/O (web transport fetch in jsdom → NETWORK_ERROR).
// Default getManifest → null (no manifest → legacy editorStateKey.paneLayout path).
const {
  mockGetManifest,
  mockWriteManifest,
  mockDeleteManifest,
  mockLogFrontendError,
  mockSetManifestRestoreInProgress,
  mockSyncStoreState
} = vi.hoisted(() => ({
  mockGetManifest: vi.fn().mockResolvedValue({ success: true, data: null }),
  mockWriteManifest: vi
    .fn()
    .mockResolvedValue({ success: true, data: { status: 'updated', revision: 1, updatedAt: 1 } }),
  mockDeleteManifest: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  mockLogFrontendError: vi.fn().mockResolvedValue(undefined),
  mockSetManifestRestoreInProgress: vi.fn(),
  mockSyncStoreState: {
    setBasedRevision: vi.fn(),
    advanceBasedRevision: vi.fn(),
    setPendingConflict: vi.fn(),
    setManifestRestoreInProgress: vi.fn(),
    getBasedRevision: vi.fn(() => null),
    hasPendingConflict: vi.fn(() => false),
    pendingConflict: null,
    basedRevisionByProject: {},
    manifestRestoreInProgressByProject: {}
  }
}))

vi.mock('@/lib/workspace-manifest-api', () => ({
  workspaceManifestApi: {
    getManifest: mockGetManifest,
    writeManifest: mockWriteManifest,
    deleteManifest: mockDeleteManifest
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

vi.mock('@/stores/workspace-manifest-sync-store', () => ({
  setManifestRestoreInProgress: mockSetManifestRestoreInProgress,
  isManifestRestoreInProgress: vi.fn(() => false),
  isManifestRestoreInProgressFor: vi.fn(() => false),
  useWorkspaceManifestSyncStore: {
    getState: vi.fn(() => mockSyncStoreState),
    setState: vi.fn(),
    subscribe: vi.fn(() => vi.fn())
  }
}))

// P11/P3: the manifest sync module is NOT mocked — the real loadWorkspaceManifest
// runs against the mocked facade (mockGetManifest) so the manifest-wins branch
// exercises the actual topology rebuild (rebuildTopologyFromManifest +
// loadProjectWorkspace). The sync-store + log facades are mocked above.

beforeEach(() => {
  mockPersistenceRead.mockReset()
  mockPersistenceWriteDebounced.mockReset()
  mockLoadPersistedTerminals.mockReset()
  mockLoadPersistedTerminals.mockResolvedValue(null)
  // P11: default getManifest → null (no manifest → legacy path).
  mockGetManifest.mockReset()
  mockGetManifest.mockResolvedValue({ success: true, data: null })
  mockWriteManifest.mockReset()
  // Re-arm: Vitest 4 `mockReset` clears `mockResolvedValue`, leaving the mock
  // returning `undefined` — tests that exercise the manifest-write path would
  // otherwise see a silent failure. Restore the default success payload
  // (mirrors the hoisted definition above).
  mockWriteManifest.mockResolvedValue({
    success: true,
    data: { status: 'updated', revision: 1, updatedAt: 1 }
  })
  mockDeleteManifest.mockReset()
  mockDeleteManifest.mockResolvedValue({ success: true, data: undefined })
  mockLogFrontendError.mockReset()
  mockSetManifestRestoreInProgress.mockReset()

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
  mockWorkspaceState.loadProjectWorkspace.mockReset()

  mockTerminalState.terminals = []
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

  it('ignores legacy fileExplorerVisible in persisted payload', async () => {
    mockExplorerState.isVisible = true

    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: ['/projects/a/src'],
        fileExplorerVisible: false,
        activeTabId: null
      }
    })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenCalledWith(['/projects/a/src'])
    })

    expect(mockExplorerState.isVisible).toBe(true)
  })

  it('keeps expanded dir persistence isolated per project', async () => {
    mockPersistenceRead
      .mockResolvedValueOnce({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/a/src'],
          activeTabId: null
        }
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/b/docs'],
          activeTabId: null
        }
      })

    const { rerender } = renderHook(({ projectId }) => useEditorPersistence(projectId), {
      initialProps: { projectId: 'project-a' }
    })

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenLastCalledWith(['/projects/a/src'])
    })

    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenLastCalledWith(['/projects/b/docs'])
    })
  })

  it('persists pane layout with mixed editor and terminal tabs', () => {
    mockEditorState.openFiles.set(
      '/projects/a/src/index.ts',
      createEditorFileState('/projects/a/src/index.ts')
    )
    mockEditorState.openFiles.set(
      '/projects/a/README.md',
      createEditorFileState('/projects/a/README.md')
    )
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

  it('restores pane layout, remaps terminal tabs to live terminals, and prunes missing editor tabs', async () => {
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

    mockTerminalState.terminals = [
      {
        id: 'live-1',
        name: 'Claude',
        projectId: 'project-a',
        shell: 'bash',
        cwd: '/projects/a',
        ptyId: 'pty-live-1'
      }
    ]
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'old-1',
      terminals: [
        {
          id: 'old-1',
          name: 'Claude',
          shell: 'bash',
          cwd: '/projects/a',
          scrollback: []
        }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockWorkspaceState.loadProjectWorkspace).toHaveBeenCalled()
    })

    const [restoredRootArg, activePaneIdArg] = mockWorkspaceState.loadProjectWorkspace.mock.calls[0]

    expect(activePaneIdArg).toBe('pane-drop')

    const restoredRoot = restoredRootArg as SplitNode
    expect(restoredRoot.type).toBe('split')

    const leftLeaf = restoredRoot.children[0] as LeafNode
    const rightLeaf = restoredRoot.children[1] as LeafNode

    expect(leftLeaf.type).toBe('leaf')
    expect(leftLeaf.id).toBe('pane-keep')
    expect(leftLeaf.tabs).toEqual([
      { type: 'terminal', id: 'term-live-1', terminalId: 'live-1' },
      {
        type: 'editor',
        id: 'edit-/projects/a/src/existing.ts',
        filePath: '/projects/a/src/existing.ts'
      }
    ])
    expect(leftLeaf.activeTabId).toBe('term-live-1')

    expect(rightLeaf.type).toBe('leaf')
    expect(rightLeaf.id).toBe('pane-drop')
    expect(rightLeaf.tabs).toEqual([])
  })

  it('keeps persisted terminal tabs during recovery-only restore when no live terminal exists', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: ['/projects/a'],
        fileExplorerVisible: true,
        activeTabId: null,
        activePaneId: 'pane-recovery',
        paneLayout: {
          type: 'leaf',
          id: 'pane-recovery',
          tabs: [{ type: 'terminal', terminalId: 'persisted-only' }],
          activeTabId: 'term-persisted-only'
        }
      }
    })
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-only',
      terminals: [
        {
          id: 'persisted-only',
          name: 'Recovered terminal',
          shell: 'bash',
          cwd: '/projects/a',
          scrollback: []
        }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockWorkspaceState.loadProjectWorkspace).toHaveBeenCalled()
    })

    const [restoredRootArg, activePaneIdArg] = mockWorkspaceState.loadProjectWorkspace.mock.calls[0]
    expect(activePaneIdArg).toBe('pane-recovery')
    expect(restoredRootArg).toEqual({
      type: 'leaf',
      id: 'pane-recovery',
      tabs: [
        {
          type: 'terminal',
          id: 'term-persisted-only',
          terminalId: 'persisted-only'
        }
      ],
      activeTabId: 'term-persisted-only'
    })
  })

  it('ignores stale restore results after switching projects', async () => {
    const projectARead = {
      resolve: undefined as
        | ((value: {
            success: true
            data: {
              openFiles: never[]
              activeFilePath: null
              expandedDirs: string[]
              fileExplorerVisible: boolean
              activeTabId: null
              activePaneId: string
              paneLayout: {
                type: 'leaf'
                id: string
                tabs: { type: 'editor'; filePath: string }[]
                activeTabId: string
              }
            }
          }) => void)
        | undefined
    }

    mockPersistenceRead
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            projectARead.resolve = resolve
          })
      )
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/b'],
          fileExplorerVisible: true,
          activeTabId: null,
          activePaneId: 'pane-b',
          paneLayout: {
            type: 'leaf',
            id: 'pane-b',
            tabs: [{ type: 'editor', filePath: '/projects/b/src/index.ts' }],
            activeTabId: 'edit-/projects/b/src/index.ts'
          }
        }
      })

    const { rerender } = renderHook(
      ({ currentProjectId }) => useEditorPersistence(currentProjectId),
      {
        initialProps: { currentProjectId: 'project-a' }
      }
    )

    rerender({ currentProjectId: 'project-b' })

    await waitFor(() => {
      expect(mockWorkspaceState.resetLayout).toHaveBeenCalledTimes(1)
    })

    projectARead.resolve?.({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: ['/projects/a'],
        fileExplorerVisible: true,
        activeTabId: null,
        activePaneId: 'pane-a',
        paneLayout: {
          type: 'leaf',
          id: 'pane-a',
          tabs: [{ type: 'editor', filePath: '/projects/a/src/index.ts' }],
          activeTabId: 'edit-/projects/a/src/index.ts'
        }
      }
    })

    await waitFor(() => {
      expect(mockPersistenceRead).toHaveBeenCalledTimes(2)
    })

    expect(mockWorkspaceState.loadProjectWorkspace).not.toHaveBeenCalled()
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

    await waitFor(() => {
      expect(mockWorkspaceState.loadProjectWorkspace).toHaveBeenCalled()
    })

    const [restoredRootArg, activePaneIdArg] = mockWorkspaceState.loadProjectWorkspace.mock.calls[0]

    expect(activePaneIdArg).toBe('pane-legacy')
    expect(restoredRootArg).toEqual({
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
          tabs: [{ type: 'terminal', id: 'term-old-1', terminalId: 'old-1' }],
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

  // P3: manifest-wins integration — when getManifest returns a real manifest,
  // loadWorkspaceManifest rebuilds the tree from the manifest's portable
  // topology and the legacy paneLayout path (reconcileTerminalTabs +
  // loadPersistedTerminals) is skipped. Asserts the workspace root matches
  // the manifest-rebuilt tree (leaf id from manifest), NOT the paneLayout tree.
  it('uses the manifest-rebuilt tree and skips the legacy paneLayout path when a manifest exists', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: [],
        activeTabId: null,
        paneLayout: {
          type: 'leaf',
          id: 'legacy-leaf',
          tabs: [{ type: 'editor', filePath: '/projects/a/legacy.ts' }],
          activeTabId: 'edit-/projects/a/legacy.ts'
        }
      }
    })
    mockGetManifest.mockResolvedValue({
      success: true,
      data: {
        projectId: 'project-a',
        revision: 3,
        updatedAt: 1,
        topology: {
          type: 'leaf',
          id: 'manifest-leaf-A',
          terminalIds: [],
          editorIds: ['edit-/manifest/file.ts'],
          activeTabId: null
        },
        activePaneId: 'manifest-leaf-A',
        focusedSessionId: null,
        terminals: [],
        editors: [{ editorId: 'edit-/manifest/file.ts', filePath: '/manifest/file.ts' }]
      }
    })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockGetManifest).toHaveBeenCalledWith('project-a')
    })

    // The manifest path rebuilt the tree → loadProjectWorkspace called with
    // the manifest-rebuilt root (leaf id 'manifest-leaf-A'), NOT 'legacy-leaf'.
    await waitFor(() => {
      expect(mockWorkspaceState.loadProjectWorkspace).toHaveBeenCalledTimes(1)
    })
    const [restoredRootArg, activePaneIdArg] = mockWorkspaceState.loadProjectWorkspace.mock.calls[0]
    expect((restoredRootArg as { id: string }).id).toBe('manifest-leaf-A')
    expect(activePaneIdArg).toBe('manifest-leaf-A')

    // The legacy path is skipped: loadPersistedTerminals + reconcileTerminalTabs
    // (which would call loadProjectWorkspace with the 'legacy-leaf' tree) are
    // NOT invoked.
    expect(mockLoadPersistedTerminals).not.toHaveBeenCalled()
    expect(mockWorkspaceState.resetLayout).not.toHaveBeenCalled()
    expect(mockWorkspaceState.syncEditorTabs).not.toHaveBeenCalled()

    // P2: the manifest's editor descriptors are seeded into openFiles.
    expect(mockEditorState.openFile).toHaveBeenCalledWith('/manifest/file.ts')
  })

  // P11: when no manifest exists (data: null), the legacy paneLayout fallback runs.
  it('falls back to the legacy paneLayout path when no manifest exists', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: [],
        activeTabId: null,
        paneLayout: {
          type: 'leaf',
          id: 'legacy-leaf',
          tabs: [{ type: 'editor', filePath: '/projects/a/legacy.ts' }],
          activeTabId: 'edit-/projects/a/legacy.ts'
        }
      }
    })
    mockGetManifest.mockResolvedValue({ success: true, data: null })
    mockLoadPersistedTerminals.mockResolvedValue(null)

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockGetManifest).toHaveBeenCalledWith('project-a')
      // The legacy path runs — loadPersistedTerminals + loadProjectWorkspace.
      expect(mockLoadPersistedTerminals).toHaveBeenCalledWith('project-a')
      expect(mockWorkspaceState.loadProjectWorkspace).toHaveBeenCalledTimes(1)
    })
  })

  // P9: the restore flow sets setManifestRestoreInProgress(projectId, true)
  // before the manifest load and (projectId, false) in the finally.
  it('sets manifestRestoreInProgress true on entry and false in finally', async () => {
    mockPersistenceRead.mockResolvedValue({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: [],
        activeTabId: null
      }
    })
    mockGetManifest.mockResolvedValue({ success: true, data: null })

    renderHook(() => useEditorPersistence('project-a'))

    await waitFor(() => {
      expect(mockGetManifest).toHaveBeenCalled()
    })

    // true is set before the load, false in the finally.
    expect(mockSetManifestRestoreInProgress).toHaveBeenCalledWith('project-a', true)
    expect(mockSetManifestRestoreInProgress).toHaveBeenCalledWith('project-a', false)

    // Verify call order: true before false.
    const calls = mockSetManifestRestoreInProgress.mock.calls
    const trueIndex = calls.findIndex(
      (call: unknown[]) => call[0] === 'project-a' && call[1] === true
    )
    const falseIndex = calls.findIndex(
      (call: unknown[]) => call[0] === 'project-a' && call[1] === false
    )
    expect(trueIndex).toBeGreaterThanOrEqual(0)
    expect(falseIndex).toBeGreaterThanOrEqual(0)
    expect(trueIndex).toBeLessThan(falseIndex)
  })
})
