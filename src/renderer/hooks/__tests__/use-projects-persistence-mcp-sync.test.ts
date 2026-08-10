import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'

const { syncMcpRegistryToProjectFile, syncProjectsMock } = vi.hoisted(() => ({
  syncMcpRegistryToProjectFile: vi.fn(async () => undefined),
  syncProjectsMock: vi.fn(async () => ({ success: true }))
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

describe('useProjectsAutoSave MCP sync on project switch (CAP-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncProjectsMock.mockResolvedValue({ success: true })

    useProjectStore.setState({
      projects: [],
      activeProjectId: 'warmup',
      isLoaded: true
    })
  })

  it('calls syncMcpRegistryToProjectFile when activeProjectId changes', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())

    // First state change initializes the hasInitialized ref (skipped by guard).
    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'warmup2' })
    })

    // Second state change: real project switch.
    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P1', color: 'blue', path: '/p1' }],
        activeProjectId: 'p1'
      })
    })

    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(syncMcpRegistryToProjectFile).toHaveBeenCalledTimes(1)
    })

    unmount()
  })

  it('does not call syncMcpRegistryToProjectFile when only projects change (no switch)', async () => {
    const { unmount } = renderHook(() => useProjectsAutoSave())

    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'warmup2' })
    })

    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P1', color: 'blue', path: '/p1' }],
        activeProjectId: 'warmup2'
      })
    })

    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalled()
    })

    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()

    unmount()
  })

  it('does not call sync when syncProjects fails', async () => {
    syncProjectsMock.mockResolvedValue({ success: false, error: 'boom' })

    const { unmount } = renderHook(() => useProjectsAutoSave())

    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'warmup2' })
    })

    await act(async () => {
      useProjectStore.setState({
        projects: [{ id: 'p2', name: 'P2', color: 'green', path: '/p2' }],
        activeProjectId: 'p2'
      })
    })

    await waitFor(() => {
      expect(syncProjectsMock).toHaveBeenCalled()
    })

    expect(syncMcpRegistryToProjectFile).not.toHaveBeenCalled()

    unmount()
  })
})
