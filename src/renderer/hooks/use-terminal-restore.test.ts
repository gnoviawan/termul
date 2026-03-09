import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { normalizeShellForStartup, useTerminalRestore } from './use-terminal-restore'

const {
  mockLoadPersistedTerminals,
  mockSaveTerminalLayout,
  mockSetTerminalRestoreInProgress,
  mockTerminalSpawn
} = vi.hoisted(() => ({
  mockLoadPersistedTerminals: vi.fn(),
  mockSaveTerminalLayout: vi.fn(),
  mockSetTerminalRestoreInProgress: vi.fn(),
  mockTerminalSpawn: vi.fn()
}))

vi.mock('./useTerminalAutoSave', () => ({
  loadPersistedTerminals: mockLoadPersistedTerminals,
  saveTerminalLayout: mockSaveTerminalLayout,
  setTerminalRestoreInProgress: mockSetTerminalRestoreInProgress
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: mockTerminalSpawn
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
  setActiveTab: vi.fn()
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
  mockWorkspaceStore.getActivePaneLeaf.mockReturnValue({
    id: 'pane-active',
    type: 'leaf',
    tabs: [],
    activeTabId: null
  })
  mockLoadPersistedTerminals.mockResolvedValue(null)
  mockSaveTerminalLayout.mockResolvedValue(undefined)
  mockTerminalSpawn.mockResolvedValue({ success: true, data: { id: 'pty-1' } })
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
})
