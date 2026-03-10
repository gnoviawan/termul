import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { PaneNode } from '@/types/workspace.types'
import { normalizeShellForStartup, useTerminalRestore } from './use-terminal-restore'

const {
  mockLoadPersistedTerminals,
  mockSaveTerminalLayout,
  mockSetTerminalRestoreInProgress,
  mockTerminalSpawn,
  mockTerminalKill
} = vi.hoisted(() => ({
  mockLoadPersistedTerminals: vi.fn(),
  mockSaveTerminalLayout: vi.fn(),
  mockSetTerminalRestoreInProgress: vi.fn(),
  mockTerminalSpawn: vi.fn(),
  mockTerminalKill: vi.fn()
}))

vi.mock('./useTerminalAutoSave', () => ({
  loadPersistedTerminals: mockLoadPersistedTerminals,
  saveTerminalLayout: mockSaveTerminalLayout,
  setTerminalRestoreInProgress: mockSetTerminalRestoreInProgress
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: mockTerminalSpawn,
    kill: mockTerminalKill
  }
}))

vi.mock('@/lib/shell-api', () => ({
  shellApi: {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: { available: [] } })
  }
}))

const mockProjectState = {
  activeProjectId: '',
  projects: [
    { id: 'project-a', path: '/projects/a' },
    { id: 'project-b', path: '/projects/b' }
  ]
}

vi.mock('../stores/project-store', () => ({
  useProjectStore: Object.assign(
    (selector?: (state: typeof mockProjectState) => unknown) =>
      selector ? selector(mockProjectState) : mockProjectState,
    {
      getState: vi.fn(() => mockProjectState)
    }
  )
}))

const mockTerminalStoreState = {
  terminals: [] as Array<{ id: string; projectId: string; name: string; shell: string; ptyId?: string }>,
  activeTerminalId: '',
  selectTerminal: vi.fn(),
  setTerminals: vi.fn(),
  addTerminal: vi.fn(),
  setTerminalPtyId: vi.fn()
}

vi.mock('../stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => mockTerminalStoreState)
  }
}))

const mockWorkspaceStore = {
  ensureTerminalTab: vi.fn(),
  getActivePaneLeaf: vi.fn(() => ({ id: 'pane-active', type: 'leaf', tabs: [], activeTabId: null })),
  setActiveTab: vi.fn(),
  root: {
    type: 'leaf',
    id: 'pane-active',
    tabs: [],
    activeTabId: null
  } as PaneNode
}

vi.mock('../stores/workspace-store', async () => {
  const actual = await vi.importActual('../stores/workspace-store')
  return {
    ...actual,
    useWorkspaceStore: {
      getState: vi.fn(() => mockWorkspaceStore)
    }
  }
})

vi.mock('../stores/app-settings-store', () => ({
  useAppSettingsStore: {
    getState: vi.fn(() => ({ settings: { defaultShell: 'bash' } }))
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectState.activeProjectId = ''
  mockTerminalStoreState.terminals = []
  mockTerminalStoreState.activeTerminalId = ''
  mockWorkspaceStore.root = {
    type: 'leaf',
    id: 'pane-active',
    tabs: [],
    activeTabId: null
  } as PaneNode
  mockWorkspaceStore.getActivePaneLeaf.mockReturnValue({
    id: 'pane-active',
    type: 'leaf',
    tabs: [],
    activeTabId: null
  })
  mockLoadPersistedTerminals.mockResolvedValue(null)
  mockSaveTerminalLayout.mockResolvedValue(undefined)
  mockTerminalSpawn.mockResolvedValue({ success: true, data: { id: 'pty-1' } })
  mockTerminalKill.mockResolvedValue({ success: true, data: undefined })
  mockTerminalStoreState.addTerminal.mockImplementation(() => ({ id: 'new-terminal' }))
})

describe('normalizeShellForStartup', () => {
  it('returns powershell when shell is empty', () => {
    expect(normalizeShellForStartup('')).toBe('powershell')
    expect(normalizeShellForStartup(undefined)).toBe('powershell')
  })

  it('normalizes cmd to powershell in tauri windows context', () => {
    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true
    })

    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true
    })

    expect(normalizeShellForStartup('cmd')).toBe('powershell')
    expect(normalizeShellForStartup('CMD.EXE')).toBe('powershell')
    expect(normalizeShellForStartup(' powershell ')).toBe(' powershell ')

    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: undefined,
      configurable: true
    })
  })

  it('does not normalize cmd outside tauri context', () => {
    Object.defineProperty(window as unknown as Record<string, unknown>, '__TAURI_INTERNALS__', {
      value: undefined,
      configurable: true
    })

    expect(normalizeShellForStartup('cmd')).toBe('cmd')
  })
})

describe('useTerminalRestore', () => {
  it('uses the pane containing the restored terminal tab when selecting a live terminal', async () => {
    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' }
    ]
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'a-live',
      terminals: [
        {
          id: 'a-live',
          name: 'A',
          shell: 'bash',
          cwd: '/projects/a',
          scrollback: []
        }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    mockWorkspaceStore.root = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'pane-other', tabs: [], activeTabId: null },
        {
          type: 'leaf',
          id: 'pane-restored',
          tabs: [{ type: 'terminal', id: 'term-a-live', terminalId: 'a-live' }],
          activeTabId: null
        }
      ]
    } as PaneNode
    mockWorkspaceStore.getActivePaneLeaf.mockReturnValue({
      id: 'pane-active',
      type: 'leaf',
      tabs: [],
      activeTabId: null
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledWith('pane-restored', 'term-a-live')
      expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('a-live')
    })
  })

  it('does not apply cancelled live-terminal restore state after a project switch', async () => {
    const projectALayout = {
      resolve: undefined as ((value: null) => void) | undefined
    }

    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' },
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]

    mockLoadPersistedTerminals
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            projectALayout.resolve = resolve
          })
      )
      .mockResolvedValueOnce(null)

    const { rerender } = renderHook(({ projectId }) => {
      mockProjectState.activeProjectId = projectId
      useTerminalRestore()
    }, {
      initialProps: { projectId: 'project-a' }
    })

    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledWith('pane-active', 'term-b-live')
    })

    projectALayout.resolve?.(null)

    await waitFor(() => {
      expect(mockLoadPersistedTerminals).toHaveBeenCalledTimes(2)
    })

    expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledTimes(1)
    expect(mockWorkspaceStore.ensureTerminalTab).toHaveBeenCalledWith('b-live', undefined, true)
    expect(mockWorkspaceStore.ensureTerminalTab).not.toHaveBeenCalledWith('a-live', undefined, true)
    expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('b-live')
  })

  it('does not spawn a fallback terminal after cancelled restore errors', async () => {
    const projectALayout = {
      reject: undefined as ((reason?: unknown) => void) | undefined
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    mockTerminalStoreState.terminals = [
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]

    mockLoadPersistedTerminals
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            projectALayout.reject = reject
          })
      )
      .mockResolvedValueOnce(null)

    try {
      const { rerender } = renderHook(({ projectId }) => {
        mockProjectState.activeProjectId = projectId
        useTerminalRestore()
      }, {
        initialProps: { projectId: 'project-a' }
      })

      rerender({ projectId: 'project-b' })

      await waitFor(() => {
        expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledWith('pane-active', 'term-b-live')
        expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('b-live')
      })

      projectALayout.reject?.(new Error('restore failed'))

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Failed to restore terminals:',
          expect.any(Error)
        )
      })

      await waitFor(() => {
        expect(mockTerminalSpawn).not.toHaveBeenCalled()
        expect(mockTerminalStoreState.addTerminal).not.toHaveBeenCalled()
      })
    } finally {
      consoleErrorSpy.mockRestore()
    }
  })

  it('kills a spawned pty when restore is cancelled after spawn succeeds', async () => {
    const spawnGate = {
      resolve: undefined as ((value: { success: true; data: { id: string } }) => void) | undefined
    }

    mockTerminalStoreState.terminals = [
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]

    mockLoadPersistedTerminals
      .mockImplementationOnce(
        () =>
          Promise.resolve({
            activeTerminalId: 'old-a',
            terminals: [
              {
                id: 'old-a',
                name: 'A',
                shell: 'bash',
                cwd: '/projects/a',
                scrollback: []
              }
            ],
            updatedAt: '2026-03-09T00:00:00.000Z'
          })
      )
      .mockResolvedValueOnce(null)

    mockTerminalSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawnGate.resolve = resolve as (value: { success: true; data: { id: string } }) => void
        })
    )

    const { rerender } = renderHook(({ projectId }) => {
      mockProjectState.activeProjectId = projectId
      useTerminalRestore()
    }, {
      initialProps: { projectId: 'project-a' }
    })

    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
    })

    rerender({ projectId: 'project-b' })
    mockTerminalStoreState.terminals = [
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]

    await waitFor(() => {
      expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledWith('pane-active', 'term-b-live')
      expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('b-live')
    })

    spawnGate.resolve?.({ success: true, data: { id: 'pty-orphan' } })

    await waitFor(() => {
      expect(mockTerminalKill).toHaveBeenCalledWith('pty-orphan')
    })

    expect(mockTerminalStoreState.setTerminals).not.toHaveBeenCalled()
    expect(mockTerminalStoreState.selectTerminal).not.toHaveBeenCalledWith('new-terminal')
  })

  it('passes a stable owner token when marking restore progress', async () => {
    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' }
    ]
    mockLoadPersistedTerminals.mockResolvedValue(null)

    const { unmount } = renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockSetTerminalRestoreInProgress).toHaveBeenCalledWith(
        'project-a',
        true,
        expect.any(String)
      )
    })

    const ownerToken = mockSetTerminalRestoreInProgress.mock.calls[0][2]
    unmount()

    await waitFor(() => {
      expect(mockSetTerminalRestoreInProgress).toHaveBeenCalledWith('project-a', false, ownerToken)
    })
  })

  it('kills a spawned default terminal pty when restore is cancelled after spawn succeeds', async () => {
    const spawnGate = {
      resolve: undefined as ((value: { success: true; data: { id: string } }) => void) | undefined
    }

    mockTerminalStoreState.terminals = []
    mockTerminalStoreState.addTerminal.mockImplementation(() => ({ id: 'new-terminal' }))
    mockLoadPersistedTerminals
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    mockTerminalSpawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawnGate.resolve = resolve as (value: { success: true; data: { id: string } }) => void
        })
    )

    const { rerender } = renderHook(({ projectId }) => {
      mockProjectState.activeProjectId = projectId
      useTerminalRestore()
    }, {
      initialProps: { projectId: 'project-a' }
    })

    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledTimes(1)
    })

    mockTerminalStoreState.terminals = [
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]
    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockWorkspaceStore.setActiveTab).toHaveBeenCalledWith('pane-active', 'term-b-live')
      expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('b-live')
    })

    spawnGate.resolve?.({ success: true, data: { id: 'pty-default-orphan' } })

    await waitFor(() => {
      expect(mockTerminalKill).toHaveBeenCalledWith('pty-default-orphan')
    })

    expect(mockTerminalStoreState.addTerminal).not.toHaveBeenCalled()
    expect(mockTerminalStoreState.setTerminalPtyId).not.toHaveBeenCalled()
    expect(mockTerminalStoreState.selectTerminal).not.toHaveBeenCalledWith('new-terminal')
  })

  // Project Switch Terminal Preservation tests
  // These tests verify the behavioral contract that PTYs are NOT killed when switching projects
  it('should NOT call terminalApi.kill when switching projects with live terminals', async () => {
    // Setup: terminals exist in both projects with live PTYs
    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' },
      { id: 'b-live', projectId: 'project-b', name: 'B', shell: 'bash', ptyId: 'pty-b' }
    ]
    mockLoadPersistedTerminals.mockResolvedValue(null)

    const { rerender } = renderHook(({ projectId }) => {
      mockProjectState.activeProjectId = projectId
      useTerminalRestore()
    }, {
      initialProps: { projectId: 'project-a' }
    })

    // Switch to project-b
    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockSaveTerminalLayout).toHaveBeenCalledWith('project-a')
    })

    // The key assertion: terminalApi.kill should NOT be called during project switch
    // (the old implementation would have called kill for project-a's terminals)
    expect(mockTerminalKill).not.toHaveBeenCalled()
  })
})