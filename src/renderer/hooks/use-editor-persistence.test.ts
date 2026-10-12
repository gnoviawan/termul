import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockPersistedTerminal, mockTerminal } from '@/lib/test-utils/terminal'
import { useAcpStore } from '@/stores/acp-store'
import {
  _resetDroppedLaunchPlaceholdersForTesting,
  setLiveLaunchSessionLookup,
  takeAllDroppedLaunchPlaceholders
} from '@/stores/acp-store/live-turn'
import { seedSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import type { ProjectWorkspace } from '@/stores/workspace-store'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import {
  deserializePaneTree,
  persistState,
  reconcileTerminalTabs,
  useEditorPersistence
} from './use-editor-persistence'

const { mockLoadPersistedTerminals } = vi.hoisted(() => ({
  mockLoadPersistedTerminals: vi.fn()
}))

const { mockPersistenceRead, mockPersistenceWriteDebounced, mockReadFile } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn(),
  mockPersistenceWriteDebounced: vi.fn(),
  mockReadFile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead,
    writeDebounced: mockPersistenceWriteDebounced
  },
  filesystemApi: { readFile: mockReadFile }
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
  setActiveFilePath: vi.fn()
}

const mockExplorerState = {
  expandedDirs: new Set<string>(),
  isVisible: true,
  setExpandedDirs: vi.fn(),
  restoreExpandedDirs: vi.fn().mockResolvedValue(undefined)
}

const mockWorkspaceState = {
  root: {
    type: 'leaf',
    id: 'pane-root',
    tabs: [],
    activeTabId: null
  } as PaneNode,
  activePaneId: 'pane-root',
  activeTabId: null as string | null,
  activeProjectId: '',
  parkedTrees: {} as Record<string, unknown>,
  // The store's park/unpark is covered in workspace-store.test.ts: here it is
  // only the recorded commit target.
  activateProject: vi.fn((projectId: string, _tree?: unknown) => {
    mockWorkspaceState.activeProjectId = projectId
  }),
  hasProjectTree: vi.fn(
    (projectId: string) =>
      mockWorkspaceState.activeProjectId === projectId ||
      projectId in mockWorkspaceState.parkedTrees
  ),
  dropProjectTree: vi.fn(),
  syncTerminalTabs: vi.fn(),
  insertAgentChatTab: vi.fn(),
  addAgentChatTab: vi.fn(),
  hideAgentLauncher: vi.fn()
}

const mockProjectState = {
  activeProjectId: 'project-a',
  projects: [
    { id: 'project-a', path: '/projects/a' },
    { id: 'project-b', path: '/projects/b' }
  ],
  selectProject: vi.fn((id: string) => {
    mockProjectState.activeProjectId = id
  })
}

vi.mock('@/stores/editor-store', () => ({
  detectLanguage: () => 'typescript',
  getDefaultViewMode: () => 'code',
  useEditorStore: {
    getState: vi.fn(() => mockEditorState),
    setState: vi.fn((patch: Partial<typeof mockEditorState>) =>
      Object.assign(mockEditorState, patch)
    ),
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
    getState: vi.fn(() => mockProjectState),
    subscribe: vi.fn(() => vi.fn())
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
  mockEditorState.setActiveFilePath.mockReset()
  mockReadFile.mockReset()
  mockReadFile.mockImplementation(async () => ({
    success: true,
    data: { content: 'disk', modifiedAt: 5 }
  }))

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
  mockWorkspaceState.activeProjectId = ''
  mockWorkspaceState.parkedTrees = {}
  mockWorkspaceState.activateProject.mockClear()
  mockWorkspaceState.syncTerminalTabs.mockReset()
  mockProjectState.activeProjectId = 'project-a'

  mockTerminalState.terminals = []
})

afterEach(() => {
  vi.clearAllMocks()
  setLiveLaunchSessionLookup(() => false)
  _resetDroppedLaunchPlaceholdersForTesting()
  useAgentChatLifetimeStore.setState({
    retainedByProject: {},
    activeSessionByProject: {},
    focusSessionByProject: {}
  })
})

/** Mount the hook on `projectId`, mirroring the project store (the user's intent) like the real layout. */
function mountPersistence(projectId: string): {
  switchTo: (nextProjectId: string) => void
} {
  mockProjectState.activeProjectId = projectId
  const hook = renderHook(({ id }) => useEditorPersistence(id), { initialProps: { id: projectId } })
  return {
    switchTo: (nextProjectId) => {
      mockProjectState.activeProjectId = nextProjectId
      hook.rerender({ id: nextProjectId })
    }
  }
}

/** The tree + project the coordinator last committed through `activateProject`. */
function lastActivation(): { projectId: string; tree: ProjectWorkspace | undefined } {
  const call = mockWorkspaceState.activateProject.mock.calls.at(-1)
  if (!call) throw new Error('nothing was committed')
  return { projectId: call[0], tree: call[1] as ProjectWorkspace | undefined }
}

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

    mountPersistence('project-a')

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

    mountPersistence('project-a')

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

    const mounted = mountPersistence('project-a')

    await waitFor(() => {
      expect(mockExplorerState.restoreExpandedDirs).toHaveBeenLastCalledWith(['/projects/a/src'])
    })

    mounted.switchTo('project-b')

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
    mockWorkspaceState.activeProjectId = 'project-a'

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

  it('refuses to persist a project whose tree is not the committed one', () => {
    mockWorkspaceState.activeProjectId = 'project-a'

    persistState('project-b')

    expect(mockPersistenceWriteDebounced).not.toHaveBeenCalled()
  })

  it('drops canvas tabs on persist (host-local runtime, never portable)', () => {
    mockEditorState.openFiles.set(
      '/projects/a/design-notes.md',
      createEditorFileState('/projects/a/design-notes.md')
    )
    mockEditorState.activeFilePath = '/projects/a/design-notes.md'

    mockWorkspaceState.root = {
      type: 'leaf',
      id: 'pane-canvas',
      tabs: [
        {
          type: 'canvas',
          id: 'canvas-project-a',
          projectId: 'project-a',
          docPath: '/projects/a/design.op'
        },
        {
          type: 'editor',
          id: 'edit-/projects/a/design-notes.md',
          filePath: '/projects/a/design-notes.md'
        }
      ],
      activeTabId: 'canvas-project-a'
    }
    mockWorkspaceState.activePaneId = 'pane-canvas'
    mockWorkspaceState.activeProjectId = 'project-a'

    persistState('project-a')

    const payload = mockPersistenceWriteDebounced.mock.calls[0][1]
    expect(payload.paneLayout.tabs).toEqual([
      { type: 'editor', filePath: '/projects/a/design-notes.md' }
    ])
  })

  it('reconcile drops a canvas tab alongside the keep rules for browser/git tabs', () => {
    const root: PaneNode = {
      type: 'leaf',
      id: 'pane-reconcile',
      tabs: [
        {
          type: 'canvas',
          id: 'canvas-project-a',
          projectId: 'project-a',
          docPath: '/projects/a/design.op'
        },
        { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
        { type: 'git', id: 'git-/projects/a', cwd: '/projects/a' },
        {
          type: 'editor',
          id: 'edit-/projects/a/src/existing.ts',
          filePath: '/projects/a/src/existing.ts'
        }
      ],
      activeTabId: 'edit-/projects/a/src/existing.ts'
    }

    const reconciled = reconcileTerminalTabs(
      root,
      new Set(['/projects/a/src/existing.ts']),
      [],
      null
    ) as LeafNode

    expect(reconciled.tabs.map((tab) => tab.type)).toEqual(['browser', 'git', 'editor'])
    expect(reconciled.activeTabId).toBe('edit-/projects/a/src/existing.ts')
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
      mockTerminal({
        id: 'live-1',
        name: 'Claude',
        projectId: 'project-a',
        cwd: '/projects/a',
        ptyId: 'pty-live-1'
      })
    ]
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'old-1',
      terminals: [
        mockPersistedTerminal({
          id: 'old-1',
          name: 'Claude',
          cwd: '/projects/a',
          scrollback: []
        })
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalled()
    })

    const { projectId: committedProjectId, tree } = lastActivation()
    expect(committedProjectId).toBe('project-a')
    expect(tree?.activePaneId).toBe('pane-drop')

    const restoredRoot = tree?.root as SplitNode
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
        mockPersistedTerminal({
          id: 'persisted-only',
          name: 'Recovered terminal',
          cwd: '/projects/a',
          scrollback: []
        })
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalled()
    })

    const { tree } = lastActivation()
    expect(tree?.activePaneId).toBe('pane-recovery')
    expect(tree?.root).toEqual({
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
    let resolveProjectARead: ((value: unknown) => void) | undefined
    mockPersistenceRead.mockImplementation((key: string) => {
      if (key === 'editor-state/project-a') {
        return new Promise((resolve) => {
          resolveProjectARead = resolve
        })
      }
      return Promise.resolve({
        success: true,
        data: {
          openFiles: [],
          activeFilePath: null,
          expandedDirs: ['/projects/b'],
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
    })

    const mounted = mountPersistence('project-a')
    await waitFor(() => expect(resolveProjectARead).toBeDefined())
    mounted.switchTo('project-b')

    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalledWith(
        'project-b',
        expect.anything()
      )
    })

    // Project A's read lands after B committed: it must be dropped.
    resolveProjectARead?.({
      success: true,
      data: {
        openFiles: [],
        activeFilePath: null,
        expandedDirs: ['/projects/a'],
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
    await Promise.resolve()
    await Promise.resolve()

    expect(mockWorkspaceState.activateProject).toHaveBeenCalledTimes(1)
    expect(mockWorkspaceState.activeProjectId).toBe('project-b')
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

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalled()
    })

    const { tree } = lastActivation()
    expect(tree?.activePaneId).toBe('pane-legacy')
    expect(tree?.root).toEqual({
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

  it('commits a fresh single-leaf layout when the destination project has no persisted state', async () => {
    mockWorkspaceState.activeProjectId = 'project-a'
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
        { type: 'leaf', id: 'pane-right', tabs: [], activeTabId: null }
      ]
    }
    mockWorkspaceState.activePaneId = 'pane-left'

    mockPersistenceRead.mockResolvedValue({ success: true, data: null })

    mountPersistence('project-b')

    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalledTimes(1)
    })
    const { projectId, tree } = lastActivation()
    expect(projectId).toBe('project-b')
    expect(tree?.root).toMatchObject({ type: 'leaf', tabs: [], activeTabId: null })
    expect(tree?.root.id).not.toBe('split-old')
    // The project left is persisted before the swap.
    expect(mockPersistenceWriteDebounced).toHaveBeenCalledWith(
      'editor-state/project-a',
      expect.anything()
    )
  })

  it('stages a visited project without a tree so its parked tree is kept', async () => {
    mockPersistenceRead.mockResolvedValue({ success: true, data: null })
    const mounted = mountPersistence('project-a')
    await waitFor(() => expect(mockWorkspaceState.activeProjectId).toBe('project-a'))
    mounted.switchTo('project-b')
    await waitFor(() => expect(mockWorkspaceState.activeProjectId).toBe('project-b'))
    // project-a now has a parked tree in the real store.
    mockWorkspaceState.parkedTrees = { 'project-a': {} }
    mockGetManifest.mockClear()
    mockLoadPersistedTerminals.mockClear()

    mounted.switchTo('project-a')

    await waitFor(() => expect(mockWorkspaceState.activeProjectId).toBe('project-a'))
    const { projectId, tree } = lastActivation()
    expect(projectId).toBe('project-a')
    expect(tree).toBeUndefined()
    // No manifest/terminal read for a tree that already exists; the parked
    // tree is reconciled against the project's live terminals.
    expect(mockGetManifest).not.toHaveBeenCalled()
    expect(mockLoadPersistedTerminals).not.toHaveBeenCalled()
    expect(mockWorkspaceState.syncTerminalTabs).toHaveBeenCalledWith([])
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

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockGetManifest).toHaveBeenCalledWith('project-a')
    })

    // The manifest path rebuilt the tree → committed root is the manifest's
    // (leaf id 'manifest-leaf-A'), NOT 'legacy-leaf'.
    await waitFor(() => {
      expect(mockWorkspaceState.activateProject).toHaveBeenCalledTimes(1)
    })
    const { tree } = lastActivation()
    expect(tree?.root.id).toBe('manifest-leaf-A')
    expect(tree?.activePaneId).toBe('manifest-leaf-A')
    expect(mockSyncStoreState.setBasedRevision).toHaveBeenCalledWith('project-a', 3)

    // The legacy path is skipped: loadPersistedTerminals + reconcileTerminalTabs
    // (which would call loadProjectWorkspace with the 'legacy-leaf' tree) are
    // NOT invoked.
    expect(mockLoadPersistedTerminals).not.toHaveBeenCalled()

    // P2: the manifest's editor descriptors are staged into the committed openFiles.
    expect(mockReadFile).toHaveBeenCalledWith('/manifest/file.ts')
    expect([...mockEditorState.openFiles.keys()]).toEqual(['/manifest/file.ts'])
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

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockGetManifest).toHaveBeenCalledWith('project-a')
      // The legacy path runs — loadPersistedTerminals + a committed tree.
      expect(mockLoadPersistedTerminals).toHaveBeenCalledWith('project-a')
      expect(mockWorkspaceState.activateProject).toHaveBeenCalledTimes(1)
    })
  })

  it('does not reinsert a dropped launch-* tab and records it for session recovery (#882)', async () => {
    _resetDroppedLaunchPlaceholdersForTesting()
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {}
    })
    mockWorkspaceState.insertAgentChatTab.mockReset()
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
          tabs: [
            { type: 'agent-chat', id: 'chat-launch-abc', sessionId: 'launch-abc' },
            { type: 'agent-chat', id: 'chat-sess-real', sessionId: 'sess-real' }
          ],
          activeTabId: 'chat-launch-abc'
        }
      }
    })
    mockGetManifest.mockResolvedValue({ success: true, data: null })
    mockLoadPersistedTerminals.mockResolvedValue(null)

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockWorkspaceState.insertAgentChatTab).toHaveBeenCalledWith('sess-real')
    })
    expect(mockWorkspaceState.insertAgentChatTab).not.toHaveBeenCalledWith('launch-abc')
    expect(takeAllDroppedLaunchPlaceholders()).toEqual([{ projectId: 'project-a', count: 1 }])
  })

  it('keeps a live launch-* tab so finalizeChatLaunch can remap it (#882)', async () => {
    setLiveLaunchSessionLookup((sessionId) => sessionId === 'launch-abc')
    mockWorkspaceState.insertAgentChatTab.mockReset()
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
          tabs: [{ type: 'agent-chat', id: 'chat-launch-abc', sessionId: 'launch-abc' }],
          activeTabId: 'chat-launch-abc'
        }
      }
    })
    mockGetManifest.mockResolvedValue({ success: true, data: null })
    mockLoadPersistedTerminals.mockResolvedValue(null)

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockWorkspaceState.insertAgentChatTab).toHaveBeenCalledWith('launch-abc')
    })
    expect(takeAllDroppedLaunchPlaceholders()).toEqual([])
  })

  it('judges chat ownership with the session index that lands during the terminal-layout read', async () => {
    const initialIndex = useAcpStore.getState().sessionIndex
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
          tabs: [
            { type: 'agent-chat', id: 'chat-s-foreign', sessionId: 's-foreign' },
            { type: 'agent-chat', id: 'chat-s-unknown', sessionId: 's-unknown' }
          ],
          activeTabId: 'chat-s-foreign'
        }
      }
    })
    mockGetManifest.mockResolvedValue({ success: true, data: null })
    // The index (proving s-foreign belongs to project-b) loads mid-restore.
    mockLoadPersistedTerminals.mockImplementation(async () => {
      useAcpStore.setState({
        sessionIndex: [
          {
            id: 's-foreign',
            agentId: 'agent-1',
            title: 's-foreign',
            cwd: '/work',
            projectId: 'project-b',
            createdAt: 1,
            lastActivityAt: 2,
            messageCount: 1,
            status: 'closed'
          }
        ]
      })
      return null
    })

    try {
      mountPersistence('project-a')

      await waitFor(() => {
        expect(mockWorkspaceState.activateProject).toHaveBeenCalled()
      })
      const tree = lastActivation().tree?.root as PaneNode
      if (tree.type !== 'leaf') throw new Error('expected leaf')
      expect(tree.tabs.map((tab) => tab.id)).toEqual(['chat-s-unknown'])
      expect(tree.activeTabId).toBe('chat-s-unknown')
    } finally {
      useAcpStore.setState({ sessionIndex: initialIndex })
    }
  })

  // P9: the switch holds setManifestRestoreInProgress(projectId, true) from the
  // request until it ends, and clears it (false) after the commit.
  it('sets manifestRestoreInProgress true on entry and false when the switch ends', async () => {
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

    mountPersistence('project-a')

    await waitFor(() => {
      expect(mockSetManifestRestoreInProgress).toHaveBeenCalledWith('project-a', false)
    })
    expect(mockGetManifest).toHaveBeenCalled()

    // true is set before the load, false once the switch ends.
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

describe('deserializePaneTree agent-chat restore (story 5)', () => {
  it('drops launch-* placeholder tabs (corpses of failed launches) and keeps real session tabs', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-sess-1',
      tabs: [
        { type: 'agent-chat', id: 'chat-launch-abc', sessionId: 'launch-abc' },
        { type: 'agent-chat', id: 'chat-sess-1', sessionId: 'sess-1' }
      ]
    })
    expect(tree.type).toBe('leaf')
    if (tree.type !== 'leaf') return
    expect(tree.tabs).toEqual([{ type: 'agent-chat', id: 'chat-sess-1', sessionId: 'sess-1' }])
    expect(tree.activeTabId).toBe('chat-sess-1')
  })

  it('tolerates a corrupt agent-chat tab without a sessionId (drops it, keeps the rest)', () => {
    const corruptTab = { type: 'agent-chat', id: 'chat-broken' } as unknown as {
      type: 'agent-chat'
      id: string
      sessionId: string
    }
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-sess-1',
      tabs: [corruptTab, { type: 'agent-chat', id: 'chat-sess-1', sessionId: 'sess-1' }]
    })
    expect(tree.type).toBe('leaf')
    if (tree.type !== 'leaf') return
    // The corrupt tab is dropped without aborting the restore of the others.
    expect(tree.tabs).toEqual([{ type: 'agent-chat', id: 'chat-sess-1', sessionId: 'sess-1' }])
    expect(tree.activeTabId).toBe('chat-sess-1')
  })

  describe('project ownership', () => {
    const indexEntry = (id: string, projectId: string) => ({
      id,
      agentId: 'agent-1',
      title: id,
      cwd: '/work',
      projectId,
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 1,
      status: 'closed' as const
    })
    const initialAcp = useAcpStore.getState()
    afterEach(() => {
      useAcpStore.setState({
        sessions: initialAcp.sessions,
        messages: initialAcp.messages,
        sessionIndex: initialAcp.sessionIndex
      })
    })

    it('drops chat tabs known to belong to another project (incl. nested splits) and repairs activeTabId', () => {
      useAcpStore.setState({
        sessionIndex: [indexEntry('s-own', 'p1'), indexEntry('s-foreign', 'p2')]
      })
      const tree = deserializePaneTree(
        {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-1',
              activeTabId: 'chat-s-foreign',
              tabs: [
                { type: 'agent-chat', id: 'chat-s-foreign', sessionId: 's-foreign' },
                { type: 'agent-chat', id: 'chat-s-own', sessionId: 's-own' }
              ]
            },
            {
              type: 'leaf',
              id: 'pane-2',
              activeTabId: 'chat-s-foreign-2',
              tabs: [{ type: 'agent-chat', id: 'chat-s-foreign-2', sessionId: 's-foreign' }]
            }
          ]
        },
        'p1'
      )
      expect(tree.type).toBe('split')
      if (tree.type !== 'split') return
      const [left, right] = tree.children
      if (left.type !== 'leaf' || right.type !== 'leaf') throw new Error('expected leaves')
      expect(left.tabs).toEqual([{ type: 'agent-chat', id: 'chat-s-own', sessionId: 's-own' }])
      expect(left.activeTabId).toBe('chat-s-own')
      expect(right.tabs).toEqual([])
      expect(mockLogFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'useEditorPersistence.deserializePaneTree',
          message: expect.stringContaining('foreign-project chat tab (session s-foreign)')
        })
      )
    })

    it('keeps chat tabs with unknown ownership, empty-owner stubs, and when no projectId is given', () => {
      // `session_created` stub: live record not yet attributed to a project.
      seedSession('s-stub', 'agent-1', false)
      useAcpStore.setState((s) => ({
        sessions: { 's-stub': { ...s.sessions['s-stub'], projectId: '' } },
        sessionIndex: [indexEntry('s-stub', ''), indexEntry('s-foreign', 'p2')]
      }))
      const layout = {
        type: 'leaf' as const,
        id: 'pane-1',
        activeTabId: null,
        tabs: [
          { type: 'agent-chat' as const, id: 'chat-s-unknown', sessionId: 's-unknown' },
          { type: 'agent-chat' as const, id: 'chat-s-stub', sessionId: 's-stub' }
        ]
      }
      const tree = deserializePaneTree(layout, 'p1')
      if (tree.type !== 'leaf') throw new Error('expected leaf')
      expect(tree.tabs.map((t) => t.id)).toEqual(['chat-s-unknown', 'chat-s-stub'])

      const unscoped = deserializePaneTree({
        ...layout,
        tabs: [{ type: 'agent-chat', id: 'chat-s-foreign', sessionId: 's-foreign' }]
      })
      if (unscoped.type !== 'leaf') throw new Error('expected leaf')
      expect(unscoped.tabs.map((t) => t.id)).toEqual(['chat-s-foreign'])
    })
  })

  it('repairs a dangling activeTabId when the active tab was a dropped launch-* corpse', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-launch-abc',
      tabs: [
        { type: 'agent-chat', id: 'chat-launch-abc', sessionId: 'launch-abc' },
        { type: 'agent-chat', id: 'chat-sess-1', sessionId: 'sess-1' }
      ]
    })
    expect(tree.type).toBe('leaf')
    if (tree.type !== 'leaf') return
    expect(tree.tabs).toHaveLength(1)
    expect(tree.activeTabId).toBe('chat-sess-1')
  })
})

describe('unrecognised persisted tab kinds (E4a)', () => {
  const unknownTab = (extra: Record<string, unknown> = {}) =>
    ({ type: 'future-kind', id: 'future-1', secretPayload: 'do-not-log', ...extra }) as never

  const warnMessages = () =>
    mockLogFrontendError.mock.calls
      .map((call) => call[0] as { level?: string; message: string })
      .filter((payload) => payload.level === 'warn')

  it('drops an unknown kind on restore without coercing it into a terminal tab', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'edit-/a.ts',
      tabs: [unknownTab(), { type: 'editor', filePath: '/a.ts' }]
    })
    expect(tree.type).toBe('leaf')
    if (tree.type !== 'leaf') return
    expect(tree.tabs).toEqual([{ type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' }])
    expect(tree.tabs.some((tab) => tab.type === 'terminal')).toBe(false)
    const warns = warnMessages()
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toContain('"future-kind"')
    expect(warns[0].message).not.toContain('do-not-log')
  })

  it('repairs activeTabId when it pointed at the dropped unknown tab', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'future-1',
      tabs: [unknownTab(), { type: 'editor', filePath: '/a.ts' }]
    })
    if (tree.type !== 'leaf') throw new Error('expected leaf')
    expect(tree.activeTabId).toBe('edit-/a.ts')
    expect(warnMessages()).toHaveLength(1)
  })

  it('falls activeTabId to null when the unknown tab was the only one', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'future-1',
      tabs: [unknownTab()]
    })
    if (tree.type !== 'leaf') throw new Error('expected leaf')
    expect(tree.tabs).toEqual([])
    expect(tree.activeTabId).toBeNull()
  })

  it('drops a ref with a missing type and reports the kind as undefined', () => {
    const tree = deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: [{} as never]
    })
    if (tree.type !== 'leaf') throw new Error('expected leaf')
    expect(tree.tabs).toEqual([])
    const warns = warnMessages()
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toContain('undefined')
  })

  it('truncates an overlong kind in the log', () => {
    deserializePaneTree({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: [{ type: 'x'.repeat(500) } as never]
    })
    const [warn] = warnMessages()
    expect(warn.message.length).toBeLessThan(200)
  })

  it('reconcileTerminalTabs drops an unknown kind with one warn and repairs activeTabId', () => {
    const root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'future-1',
      tabs: [unknownTab(), { type: 'git', id: 'git-1', cwd: '/repo' }]
    } as unknown as PaneNode
    const result = reconcileTerminalTabs(root, new Set(), [], null)
    if (result.type !== 'leaf') throw new Error('expected leaf')
    expect(result.tabs).toEqual([{ type: 'git', id: 'git-1', cwd: '/repo' }])
    expect(result.activeTabId).toBe('git-1')
    expect(warnMessages()).toHaveLength(1)
  })

  it('reconcileTerminalTabs drops canvas tabs silently', () => {
    const root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'canvas-1',
      tabs: [{ type: 'canvas', id: 'canvas-1', projectId: 'p', docPath: '/d.op' }]
    } as unknown as PaneNode
    const result = reconcileTerminalTabs(root, new Set(), [], null)
    if (result.type !== 'leaf') throw new Error('expected leaf')
    expect(result.tabs).toEqual([])
    expect(warnMessages()).toHaveLength(0)
  })
})
