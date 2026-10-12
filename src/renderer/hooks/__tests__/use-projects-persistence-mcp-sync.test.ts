import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'

const { syncMcpRegistryToProjectFile, syncProjectsMock } = vi.hoisted(() => ({
  syncMcpRegistryToProjectFile: vi.fn(async () => undefined),
  syncProjectsMock: vi.fn(async () => ({ success: true, data: 'p1' as string | null }))
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(async () => ({ success: true })),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  },
  secureStorageApi: {
    setSecret: vi.fn(async () => ({ success: true })),
    getSecret: vi.fn(async () => ({ success: false })),
    deleteSecret: vi.fn(async () => ({ success: true }))
  },
  syncProjects: syncProjectsMock,
  terminalApi: { kill: vi.fn(async () => ({ success: true })) },
  worktreeApi: { list: vi.fn(async () => ({ success: false })) }
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true,
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/stores/remote-status-store', () => ({
  useRemoteStatusStore: {
    getState: () => ({ status: { running: true } }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: {
    getState: () => ({ syncMcpRegistryToProjectFile })
  }
}))
vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: { getState: () => ({ terminals: [] }) }
}))
vi.mock('@/stores/workspace-manifest-sync-store', () => ({
  useWorkspaceManifestSyncStore: {
    getState: () => ({
      setBasedRevision: vi.fn(),
      setManifestRestoreInProgress: vi.fn(),
      pendingConflict: null,
      setPendingConflict: vi.fn()
    })
  }
}))
vi.mock('@/lib/workspace-manifest-api', () => ({
  workspaceManifestApi: { deleteManifest: vi.fn(async () => ({ success: true })) }
}))
vi.mock('@/lib/terminal-api', () => ({
  setTerminalProtected: vi.fn(async () => ({ success: true }))
}))
vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => ({ onEvent: () => () => {} })
}))
vi.mock('@/lib/web-server-api', () => ({
  webServerProjects: { list: vi.fn() }
}))

import { useProjectsAutoSave } from '../use-projects-persistence'

describe('useProjectsAutoSave host sync vs navigation (CAP-7 interim bridge)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncProjectsMock.mockResolvedValue({ success: true, data: 'p1' })

    useProjectStore.setState({
      projects: [{ id: 'p1', name: 'P1', color: 'blue', path: '/p1' }],
      activeProjectId: 'p1',
      isLoaded: true
    })
  })

  async function initialize(): Promise<void> {
    // First state change initializes the hasInitialized ref (skipped by guard).
    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'warmup' })
    })
  }

  it('pushes nothing and syncs no MCP file when only the active project changes', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())
    await initialize()

    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'p1' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(syncProjectsMock).not.toHaveBeenCalled()
    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()
    unmount()
  })

  it('mirrors a project-list change without the active project or an MCP sync', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())
    await initialize()

    await act(async () => {
      useProjectStore.setState({
        projects: [
          { id: 'p1', name: 'P1', color: 'blue', path: '/p1' },
          { id: 'p2', name: 'P2', color: 'green', path: '/p2' }
        ],
        activeProjectId: 'p2'
      })
    })

    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalledTimes(1)
    })
    const [summaries, ...rest] = syncProjectsMock.mock.calls[0] as unknown as unknown[]
    expect(rest).toEqual([])
    expect(summaries).toEqual([
      { id: 'p1', name: 'P1', color: 'blue', path: '/p1', isArchived: false, isDefault: false },
      { id: 'p2', name: 'P2', color: 'green', path: '/p2', isArchived: false, isDefault: false }
    ])
    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()
    unmount()
  })

  it('mirrors the MCP registry when the stored default project changes', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())
    await initialize()

    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P1', color: 'blue', path: '/p1', isDefault: true }]
      })
    })

    await waitFor(() => {
      expect(syncMcpRegistryToProjectFile).toHaveBeenCalledTimes(1)
    })
    unmount()
  })

  it('mirrors the MCP registry when the host falls back to a different effective default', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())
    await initialize()

    // First reply only establishes the baseline (host default p1).
    await act(async () => {
      useProjectStore.setState({
        projects: [
          { id: 'p1', name: 'P1', color: 'blue', path: '/p1' },
          { id: 'p2', name: 'P2', color: 'green', path: '/p2' }
        ]
      })
    })
    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalledTimes(1)
    })
    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()

    // p1 disappears: the host falls back to p2 without any stored flag moving.
    syncProjectsMock.mockResolvedValue({ success: true, data: 'p2' })
    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p2', name: 'P2', color: 'green', path: '/p2' }]
      })
    })
    await waitFor(() => {
      expect(syncMcpRegistryToProjectFile).toHaveBeenCalledTimes(1)
    })
    unmount()
  })

  it('does not mirror the MCP registry when the default change sync fails', async () => {
    syncProjectsMock.mockResolvedValue({ success: false, error: 'boom' })
    const { unmount } = renderHook(() => useProjectsAutoSave())
    await initialize()

    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P1', color: 'blue', path: '/p1', isDefault: true }]
      })
    })

    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalled()
    })
    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()
    unmount()
  })
})
