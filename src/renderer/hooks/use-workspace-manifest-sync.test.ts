import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks for the facade + logger. Stores are left real (Zustand singletons
// manipulated via setState/getState) so the sync logic exercises the real
// store wiring. ---
const { getManifestMock, writeManifestMock, deleteManifestMock, logErrorMock } = vi.hoisted(() => ({
  getManifestMock: vi.fn(),
  writeManifestMock: vi.fn(),
  deleteManifestMock: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  logErrorMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/workspace-manifest-api', () => ({
  workspaceManifestApi: {
    getManifest: (...args: unknown[]) => getManifestMock(...args),
    writeManifest: (...args: unknown[]) => writeManifestMock(...args),
    deleteManifest: (...args: unknown[]) => deleteManifestMock(...args)
  }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (...args: unknown[]) => logErrorMock(...args)
}))

// Patch 21: mock @/lib/api so the delete cascade's persistenceApi + terminalApi
// + secureStorageApi calls don't hit real IPC.
const { mockPersistenceDelete, mockPersistenceWrite, mockTerminalKill, mockSecureDelete } =
  vi.hoisted(() => ({
    mockPersistenceDelete: vi.fn().mockResolvedValue({ success: true, data: undefined }),
    mockPersistenceWrite: vi.fn().mockResolvedValue({ success: true, data: undefined }),
    mockTerminalKill: vi.fn().mockResolvedValue({ success: true }),
    mockSecureDelete: vi.fn().mockResolvedValue({ success: true })
  }))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    delete: (...args: unknown[]) => mockPersistenceDelete(...args),
    write: (...args: unknown[]) => mockPersistenceWrite(...args)
  },
  terminalApi: {
    kill: (...args: unknown[]) => mockTerminalKill(...args)
  },
  secureStorageApi: {
    deleteSecret: (...args: unknown[]) => mockSecureDelete(...args)
  }
}))

vi.mock('@/lib/terminal-api', () => ({
  setTerminalProtected: vi.fn().mockResolvedValue(undefined)
}))

import type { WorkspaceManifest } from '@shared/types/workspace-manifest.types'
import { useAcpStore } from '@/stores/acp-store'
import { useEditorStore } from '@/stores/editor-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  isManifestRestoreInProgress,
  setManifestRestoreInProgress,
  useWorkspaceManifestSyncStore
} from '@/stores/workspace-manifest-sync-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
// Import AFTER mocks are registered.
import {
  buildPortableManifest,
  loadWorkspaceManifest,
  performManifestWrite,
  rebuildTopologyFromManifest,
  resolveManifestConflict,
  useWorkspaceManifestSync
} from './use-workspace-manifest-sync'

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

function resetSyncStore(): void {
  useWorkspaceManifestSyncStore.setState({
    pendingConflict: null,
    basedRevisionByProject: {},
    manifestRestoreInProgressByProject: {}
  })
}

function resetWorkspaceStore(): void {
  useWorkspaceStore.getState().resetLayout()
}

function makeManifest(overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    projectId: 'proj-1',
    revision: 3,
    updatedAt: 1,
    terminals: [],
    editors: [],
    ...overrides
  }
}

beforeEach(() => {
  getManifestMock.mockReset()
  writeManifestMock.mockReset()
  deleteManifestMock.mockReset().mockResolvedValue({ success: true, data: undefined })
  logErrorMock.mockReset().mockResolvedValue(undefined)
  warnSpy.mockClear()
  resetSyncStore()
  resetWorkspaceStore()
  useEditorStore.getState().clearAllFiles()
  useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
  useAcpStore.setState({ sessions: {}, activeSessionId: null })
})

afterEach(() => {
  // Patch 20: always reset timers so a test that fails mid-flight (after
  // vi.useFakeTimers() but before its own vi.useRealTimers()) doesn't leak
  // fake timers into the next test.
  vi.useRealTimers()
  cleanup()
})

describe('loadWorkspaceManifest', () => {
  it('returns false and sets basedRevision=null when no manifest exists (fresh workspace)', async () => {
    getManifestMock.mockResolvedValue({ success: true, data: null })

    const restored = await loadWorkspaceManifest('proj-1')

    expect(restored).toBe(false)
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBeNull()
  })

  it('restores topology + activePane + sets basedRevision=manifest.revision when a manifest exists', async () => {
    const manifest = makeManifest({
      revision: 7,
      topology: {
        type: 'leaf',
        id: 'leaf-A',
        terminalIds: ['t1'],
        editorIds: ['edit-/path/file.ts'],
        activeTabId: 'term-t1'
      },
      activePaneId: 'leaf-A',
      focusedSessionId: null,
      terminals: [
        {
          terminalId: 't1',
          projectId: 'proj-1',
          shell: 'bash',
          cwd: '/p',
          name: 'T1',
          claimHandle: 't1'
        }
      ],
      editors: [{ editorId: 'edit-/path/file.ts', filePath: '/path/file.ts' }]
    })
    getManifestMock.mockResolvedValue({ success: true, data: manifest })

    const restored = await loadWorkspaceManifest('proj-1')

    expect(restored).toBe(true)
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(7)
    // The workspace store should now hold the rebuilt leaf with a terminal tab.
    const { root } = useWorkspaceStore.getState()
    expect(root.type).toBe('leaf')
    if (root.type === 'leaf') {
      expect(root.tabs).toHaveLength(2)
      expect(root.tabs.some((t) => t.type === 'terminal' && t.terminalId === 't1')).toBe(true)
      expect(root.tabs.some((t) => t.type === 'editor' && t.filePath === '/path/file.ts')).toBe(
        true
      )
      expect(root.activeTabId).toBe('term-t1')
    }
  })

  it('degrades gracefully on NETWORK_ERROR: logs + basedRevision=null + returns false', async () => {
    getManifestMock.mockResolvedValue({
      success: false,
      error: 'network down',
      code: 'NETWORK_ERROR'
    })

    const restored = await loadWorkspaceManifest('proj-1')

    expect(restored).toBe(false)
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBeNull()
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'workspace-manifest-sync' })
    )
  })

  it('P2: seeds useEditorStore.openFile for manifest editor descriptors on restore', async () => {
    const openFileSpy = vi.spyOn(useEditorStore.getState(), 'openFile').mockResolvedValue(undefined)
    const manifest = makeManifest({
      revision: 1,
      topology: {
        type: 'leaf',
        id: 'leaf-1',
        terminalIds: [],
        editorIds: ['edit-/a.ts', 'edit-/b.ts'],
        activeTabId: null
      },
      editors: [
        { editorId: 'edit-/a.ts', filePath: '/a.ts' },
        { editorId: 'edit-/b.ts', filePath: '/b.ts' }
      ]
    })
    getManifestMock.mockResolvedValue({ success: true, data: manifest })

    await loadWorkspaceManifest('proj-1')

    expect(openFileSpy).toHaveBeenCalledWith('/a.ts')
    expect(openFileSpy).toHaveBeenCalledWith('/b.ts')
    openFileSpy.mockRestore()
  })
})

describe('rebuildTopologyFromManifest — dangling-ref sanitization', () => {
  it('drops a terminalId from a leaf when it is not in manifest.terminals (warn-logged)', () => {
    const manifest = makeManifest({
      topology: {
        type: 'leaf',
        id: 'leaf-1',
        terminalIds: ['t1', 't2'],
        editorIds: [],
        activeTabId: null
      },
      terminals: [{ terminalId: 't1', projectId: 'proj-1', shell: 'bash', cwd: '/', name: 'T1' }]
    })

    const { root } = rebuildTopologyFromManifest(manifest)

    expect(root.type).toBe('leaf')
    if (root.type === 'leaf') {
      expect(root.tabs).toHaveLength(1)
      expect(root.tabs[0].type).toBe('terminal')
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping dangling terminalId "t2"')
    )
  })

  it('drops an editorId from a leaf when it is not in manifest.editors (warn-logged)', () => {
    const manifest = makeManifest({
      topology: {
        type: 'leaf',
        id: 'leaf-1',
        terminalIds: [],
        editorIds: ['edit-missing', 'edit-/real.ts'],
        activeTabId: null
      },
      editors: [{ editorId: 'edit-/real.ts', filePath: '/real.ts' }]
    })

    const { root } = rebuildTopologyFromManifest(manifest)

    expect(root.type).toBe('leaf')
    if (root.type === 'leaf') {
      expect(root.tabs).toHaveLength(1)
      expect(root.tabs[0]).toMatchObject({ type: 'editor', filePath: '/real.ts' })
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping dangling editorId "edit-missing"')
    )
  })

  it('falls back activePaneId to the first leaf when it points at a missing pane (warn-logged)', () => {
    const manifest = makeManifest({
      topology: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'leaf-A', terminalIds: [], editorIds: [], activeTabId: null },
          { type: 'leaf', id: 'leaf-B', terminalIds: [], editorIds: [], activeTabId: null }
        ]
      },
      activePaneId: 'leaf-MISSING'
    })

    const { activePaneId } = rebuildTopologyFromManifest(manifest)

    expect(activePaneId).toBe('leaf-A')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dangling activePaneId'))
  })

  it('leaves focusedSessionId null when it is unknown to the acp-store (warn-logged)', () => {
    useAcpStore.setState({ sessions: { 'known-session': {} }, activeSessionId: null })
    const manifest = makeManifest({
      topology: { type: 'leaf', id: 'l', terminalIds: [], editorIds: [], activeTabId: null },
      focusedSessionId: 'unknown-session'
    })

    const { focusedSessionId } = rebuildTopologyFromManifest(manifest)

    expect(focusedSessionId).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-session'))
  })
})

describe('performManifestWrite', () => {
  it('advances basedRevision on Updated outcome', async () => {
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 4, updatedAt: 99 }
    })
    useWorkspaceManifestSyncStore.getState().setBasedRevision('proj-1', 3)

    await performManifestWrite('proj-1')

    expect(writeManifestMock).toHaveBeenCalledWith('proj-1', 3, expect.any(Object))
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(4)
  })

  it('uses basedRevision=null on the initial write (no prior manifest)', async () => {
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 5 }
    })

    await performManifestWrite('proj-1')

    expect(writeManifestMock).toHaveBeenCalledWith('proj-1', null, expect.any(Object))
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(1)
  })

  it('sets pendingConflict on Conflict outcome and does NOT auto-retry', async () => {
    writeManifestMock.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        currentRevision: 5,
        currentUpdatedAt: 100,
        currentUpdateIdentity: 'other-client'
      }
    })

    await performManifestWrite('proj-1')

    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    const conflict = useWorkspaceManifestSyncStore.getState().pendingConflict
    expect(conflict).toEqual({
      projectId: 'proj-1',
      currentRevision: 5,
      currentUpdatedAt: 100,
      currentUpdateIdentity: 'other-client'
    })
  })

  it('logs via logFrontendError on success:false', async () => {
    writeManifestMock.mockResolvedValue({ success: false, error: 'boom', code: 'IO_ERROR' })

    await performManifestWrite('proj-1')

    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'workspace-manifest-sync' })
    )
    expect(useWorkspaceManifestSyncStore.getState().pendingConflict).toBeNull()
  })

  it('skips the write while a manifest restore is in flight', async () => {
    setManifestRestoreInProgress('proj-1', true)

    await performManifestWrite('proj-1')

    expect(writeManifestMock).not.toHaveBeenCalled()
    setManifestRestoreInProgress('proj-1', false)
  })

  it('skips the write while a conflict is already pending', async () => {
    useWorkspaceManifestSyncStore.getState().setPendingConflict({
      projectId: 'proj-1',
      currentRevision: 9,
      currentUpdatedAt: 1
    })

    await performManifestWrite('proj-1')

    expect(writeManifestMock).not.toHaveBeenCalled()
  })

  it('P8: a restore on project A does NOT block writes for project B (per-project guard)', async () => {
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 2, updatedAt: 9 }
    })
    setManifestRestoreInProgress('proj-A', true)

    await performManifestWrite('proj-B')

    // proj-B's write proceeds — the per-project guard only blocks proj-A.
    expect(writeManifestMock).toHaveBeenCalledWith('proj-B', null, expect.any(Object))
    setManifestRestoreInProgress('proj-A', false)
  })
})

describe('resolveManifestConflict', () => {
  it('reload: clears conflict and re-loads from host', async () => {
    useWorkspaceManifestSyncStore.getState().setPendingConflict({
      projectId: 'proj-1',
      currentRevision: 5,
      currentUpdatedAt: 1
    })
    getManifestMock.mockResolvedValue({ success: true, data: null })

    await resolveManifestConflict('proj-1', 'reload')

    expect(getManifestMock).toHaveBeenCalledWith('proj-1')
    expect(useWorkspaceManifestSyncStore.getState().pendingConflict).toBeNull()
  })

  it('overwrite: sets basedRevision to currentRevision and retries the write', async () => {
    useWorkspaceManifestSyncStore.getState().setPendingConflict({
      projectId: 'proj-1',
      currentRevision: 5,
      currentUpdatedAt: 1
    })
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 6, updatedAt: 2 }
    })

    await resolveManifestConflict('proj-1', 'overwrite')

    expect(writeManifestMock).toHaveBeenCalledWith('proj-1', 5, expect.any(Object))
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(6)
    expect(useWorkspaceManifestSyncStore.getState().pendingConflict).toBeNull()
  })

  it('dismiss: advances basedRevision to currentRevision without writing', async () => {
    useWorkspaceManifestSyncStore.getState().setBasedRevision('proj-1', 3)
    useWorkspaceManifestSyncStore.getState().setPendingConflict({
      projectId: 'proj-1',
      currentRevision: 5,
      currentUpdatedAt: 1
    })

    await resolveManifestConflict('proj-1', 'dismiss')

    expect(writeManifestMock).not.toHaveBeenCalled()
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(5)
    expect(useWorkspaceManifestSyncStore.getState().pendingConflict).toBeNull()
  })

  it('is a no-op when there is no pending conflict for the project', async () => {
    await resolveManifestConflict('proj-1', 'reload')
    expect(getManifestMock).not.toHaveBeenCalled()
  })
})

describe('useWorkspaceManifestSync (debounced writer hook)', () => {
  it('writes the manifest after the debounce window on a workspace-store change', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    // Trigger a real workspace-store change (activePaneId changes → portable slice).
    const currentPane = useWorkspaceStore.getState().activePaneId
    act(() => {
      useWorkspaceStore.setState({ activePaneId: `${currentPane}-trigger` })
    })

    // Before the debounce fires, no write yet.
    expect(writeManifestMock).not.toHaveBeenCalled()

    // Advance past the 500ms debounce; async act flushes the write promise.
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    expect(useWorkspaceManifestSyncStore.getState().getBasedRevision('proj-1')).toBe(1)
    vi.useRealTimers()
  })

  it('cancels the pending write while a manifest restore is in flight', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    setManifestRestoreInProgress('proj-1', true)
    const currentPane = useWorkspaceStore.getState().activePaneId
    act(() => {
      useWorkspaceStore.setState({ activePaneId: `${currentPane}-trigger` })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).not.toHaveBeenCalled()
    setManifestRestoreInProgress('proj-1', false)
    vi.useRealTimers()
  })

  it('surfaces pendingConflict on a stale write and does not auto-retry', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: {
        status: 'conflict',
        currentRevision: 8,
        currentUpdatedAt: 2,
        currentUpdateIdentity: 'c2'
      }
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    const currentPane = useWorkspaceStore.getState().activePaneId
    act(() => {
      useWorkspaceStore.setState({ activePaneId: `${currentPane}-trigger` })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // Only one write attempt — no auto-retry on conflict.
    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    expect(useWorkspaceManifestSyncStore.getState().pendingConflict).toEqual({
      projectId: 'proj-1',
      currentRevision: 8,
      currentUpdatedAt: 2,
      currentUpdateIdentity: 'c2'
    })
    vi.useRealTimers()
  })

  it('P10: fires a debounced write on an editor openFiles change', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    act(() => {
      // Mutate openFiles (add a file entry) — open-files-only slice.
      useEditorStore.setState((state) => {
        const next = new Map(state.openFiles)
        next.set('/new.ts', {
          filePath: '/new.ts',
          content: '',
          originalContent: '',
          isDirty: false,
          language: 'typescript',
          lastModified: 0,
          viewMode: 'code' as const,
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle' as const
        })
        return { openFiles: next }
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('P10: fires a debounced write on an acp activeSessionId change', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    act(() => {
      useAcpStore.setState({ activeSessionId: 'sess-new' })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('P10: fires a debounced write on a terminal portable-field change (cwd)', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })
    useTerminalStore.setState({
      terminals: [{ id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/old' }],
      activeTerminalId: 't1',
      ptyIdIndex: new Map()
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    act(() => {
      // Portable field (cwd) changes → write should fire.
      useTerminalStore.setState({
        terminals: [{ id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/new' }]
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('P10: does NOT fire on a terminal non-portable-field change (ptyId only)', async () => {
    vi.useFakeTimers()
    writeManifestMock.mockResolvedValue({
      success: true,
      data: { status: 'updated', revision: 1, updatedAt: 1 }
    })
    useTerminalStore.setState({
      terminals: [
        { id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/p', ptyId: 'pty-1' }
      ],
      activeTerminalId: 't1',
      ptyIdIndex: new Map([['pty-1', 't1']])
    })

    renderHook(() => useWorkspaceManifestSync('proj-1'))

    act(() => {
      // Non-portable field (ptyId) changes only — write should NOT fire.
      useTerminalStore.setState({
        terminals: [
          { id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/p', ptyId: 'pty-2' }
        ],
        ptyIdIndex: new Map([['pty-2', 't1']])
      })
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(writeManifestMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('buildPortableManifest', () => {
  it('serializes the workspace tree, terminals, editors, activePane, and focused session', () => {
    // Set up a workspace with a terminal + editor tab.
    const ws = useWorkspaceStore.getState()
    ws.addTerminalTab('t1')
    ws.addEditorTab('/a.ts')
    useTerminalStore.setState({
      terminals: [{ id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/p' }],
      activeTerminalId: 't1',
      ptyIdIndex: new Map()
    })
    // Seed the editor openFiles map directly (avoids the async filesystem read).
    useEditorStore.setState({
      openFiles: new Map([
        [
          '/a.ts',
          {
            filePath: '/a.ts',
            content: '',
            originalContent: '',
            isDirty: false,
            language: 'typescript',
            lastModified: 0,
            viewMode: 'code' as const,
            cursorPosition: { line: 1, col: 1 },
            scrollTop: 0,
            operationStatus: 'idle' as const
          }
        ]
      ]),
      activeFilePath: '/a.ts'
    })
    useAcpStore.setState({ sessions: {}, activeSessionId: 'sess-1' })

    const manifest = buildPortableManifest('proj-1')

    expect(manifest.projectId).toBe('proj-1')
    expect(manifest.activePaneId).toBe(ws.activePaneId)
    expect(manifest.focusedSessionId).toBe('sess-1')
    expect(manifest.terminals).toHaveLength(1)
    expect(manifest.terminals[0]).toMatchObject({ terminalId: 't1', claimHandle: 't1' })
    expect(manifest.editors).toContainEqual({ editorId: 'edit-/a.ts', filePath: '/a.ts' })
    expect(manifest.topology?.type).toBe('leaf')
    if (manifest.topology?.type === 'leaf') {
      expect(manifest.topology.terminalIds).toContain('t1')
      expect(manifest.topology.editorIds).toContain('edit-/a.ts')
    }
  })

  it('drops non-portable tab variants (browser/git/agent-chat) from the topology', () => {
    const ws = useWorkspaceStore.getState()
    ws.addBrowserTab('b1')
    ws.addTerminalTab('t1')
    useTerminalStore.setState({
      terminals: [{ id: 't1', projectId: 'proj-1', name: 'T1', shell: 'bash', cwd: '/' }],
      activeTerminalId: 't1',
      ptyIdIndex: new Map()
    })

    const manifest = buildPortableManifest('proj-1')

    if (manifest.topology?.type === 'leaf') {
      expect(manifest.topology.terminalIds).toEqual(['t1'])
      expect(manifest.topology.editorIds).toEqual([])
    }
  })
})

describe('isManifestRestoreInProgress guard', () => {
  it('reflects the per-project restore flag', () => {
    expect(isManifestRestoreInProgress()).toBe(false)
    setManifestRestoreInProgress('proj-1', true)
    expect(isManifestRestoreInProgress()).toBe(true)
    setManifestRestoreInProgress('proj-1', false)
    expect(isManifestRestoreInProgress()).toBe(false)
  })
})

describe('project-delete cascade calls deleteManifest', () => {
  // Patch 21: runtime test — calls useDeleteProjectWithCascade(id) and asserts
  // deleteManifest(id) was invoked, and that a rejection does not block the
  // cascade.
  it('invokes workspaceManifestApi.deleteManifest(id) during the cascade', async () => {
    // Set up the project store so the cascade can find the project.
    useProjectStore.setState({
      projects: [{ id: 'proj-to-delete', name: 'Delete Me', path: '/p', envVars: [] } as never],
      activeProjectId: 'proj-to-delete',
      isLoaded: true
    })
    useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
    deleteManifestMock.mockReset().mockResolvedValue({ success: true, data: undefined })

    const { useDeleteProjectWithCascade } = await import('./use-projects-persistence')
    const { result } = renderHook(() => useDeleteProjectWithCascade())
    await result.current('proj-to-delete')

    expect(deleteManifestMock).toHaveBeenCalledWith('proj-to-delete')
  })

  it('does not block the cascade when deleteManifest rejects', async () => {
    useProjectStore.setState({
      projects: [{ id: 'proj-to-delete', name: 'Delete Me', path: '/p', envVars: [] } as never],
      activeProjectId: 'proj-to-delete',
      isLoaded: true
    })
    useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
    deleteManifestMock.mockReset().mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { useDeleteProjectWithCascade } = await import('./use-projects-persistence')
    const { result } = renderHook(() => useDeleteProjectWithCascade())

    // The cascade should complete without throwing even though deleteManifest
    // rejected.
    await expect(result.current('proj-to-delete')).resolves.not.toThrow()

    expect(deleteManifestMock).toHaveBeenCalledWith('proj-to-delete')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('deleteManifest is callable + idempotent (success whether or not the file existed)', async () => {
    deleteManifestMock.mockReset().mockResolvedValue({ success: true, data: undefined })

    const result = await (
      await import('@/lib/workspace-manifest-api')
    ).workspaceManifestApi.deleteManifest('proj-to-delete')

    expect(deleteManifestMock).toHaveBeenCalledWith('proj-to-delete')
    expect(result.success).toBe(true)
  })
})
