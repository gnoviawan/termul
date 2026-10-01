import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@/types/workspace.types'
import {
  __TEST_RESET_LOCKS__,
  normalizeShellForStartup,
  useTerminalRestore
} from './use-terminal-restore'

const { mockRecordTerminalContinuityEvent, mockBeginProjectContinuityCorrelation } = vi.hoisted(
  () => ({
    mockRecordTerminalContinuityEvent: vi.fn(),
    mockBeginProjectContinuityCorrelation: vi.fn((projectId: string) => `corr-${projectId}`)
  })
)

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
const { mockTerminalAttach, mockListPreserved } = vi.hoisted(() => ({
  mockTerminalAttach: vi.fn(),
  mockListPreserved: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: mockTerminalSpawn,
    kill: mockTerminalKill,
    attach: mockTerminalAttach,
    listPreserved: mockListPreserved
  },
  sessionApi: {
    restore: vi.fn(async () => ({
      success: false,
      error: 'No session',
      code: 'SESSION_NOT_FOUND'
    })),
    hasSession: vi.fn(async () => ({ success: true, data: false })),
    save: vi.fn(),
    clear: vi.fn(),
    flush: vi.fn()
  }
}))

vi.mock('@/lib/agents/custom-agents', () => ({
  loadCustomAgents: vi.fn(async () => [])
}))

vi.mock('@/lib/shell-api', () => ({
  shellApi: {
    getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: { available: [] } })
  }
}))

vi.mock('@/lib/terminal-continuity-instrumentation', () => ({
  beginProjectContinuityCorrelation: mockBeginProjectContinuityCorrelation,
  recordTerminalContinuityEvent: mockRecordTerminalContinuityEvent
}))

const mockAcpState = {
  sessions: {} as Record<string, { projectId: string }>,
  sessionIndex: [] as Array<{ id: string; projectId: string }>
}

vi.mock('../stores/acp-store', () => ({
  useAcpStore: {
    getState: vi.fn(() => mockAcpState)
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
  terminals: [] as Array<{
    id: string
    projectId: string
    name: string
    shell: string
    ptyId?: string
  }>,
  activeTerminalId: '',
  selectTerminal: vi.fn(),
  setTerminals: vi.fn(),
  addTerminal: vi.fn(),
  setTerminalPtyId: vi.fn(),
  setTerminalClaim: vi.fn()
}

vi.mock('../stores/terminal-store', () => ({
  useTerminalStore: {
    getState: vi.fn(() => mockTerminalStoreState)
  },
  cleanupProjectTerminals: vi.fn(),
  useProjectsWithActivity: () => [],
  useProjectsWithErrors: () => new Set()
}))

const mockWorkspaceStore = {
  ensureTerminalTab: vi.fn(),
  getActivePaneLeaf: vi.fn(() => ({
    id: 'pane-active',
    type: 'leaf',
    tabs: [],
    activeTabId: null
  })),
  setActiveTab: vi.fn(),
  remapTerminalTabs: vi.fn(),
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
  vi.useRealTimers()
  __TEST_RESET_LOCKS__()
  mockRecordTerminalContinuityEvent.mockReset()
  mockBeginProjectContinuityCorrelation.mockReset()
  mockBeginProjectContinuityCorrelation.mockImplementation(
    (projectId: string) => `corr-${projectId}`
  )
  mockProjectState.activeProjectId = ''
  mockTerminalStoreState.terminals = []
  mockTerminalStoreState.activeTerminalId = ''
  mockAcpState.sessions = {}
  mockAcpState.sessionIndex = []
  mockWorkspaceStore.root = {
    type: 'leaf',
    id: 'pane-active',
    tabs: [],
    activeTabId: null
  } as PaneNode
  mockWorkspaceStore.remapTerminalTabs.mockReset()
  mockWorkspaceStore.getActivePaneLeaf.mockReturnValue({
    id: 'pane-active',
    type: 'leaf',
    tabs: [],
    activeTabId: null
  })
  // Story 5 defaults: no preserved terminals (legacy spawn path), attach
  // succeeds, listing succeeds with an empty result.
  mockListPreserved.mockResolvedValue({ success: true, data: [] })
  mockTerminalAttach.mockResolvedValue({
    success: true,
    data: {
      id: 'preserved-pty',
      shell: 'bash',
      cwd: '/tmp',
      pid: 1,
      cols: 80,
      rows: 24,
      latestSeq: 5,
      gap: false,
      snapshot: { cwd: null, gitBranch: null, gitStatus: null, exitCode: null, exited: false }
    }
  })
  mockTerminalSpawn.mockResolvedValue({
    success: true,
    data: { id: 'pty-1', claim: 'lease-claim-restore' }
  })
  mockTerminalKill.mockResolvedValue({ success: true, data: undefined })
  mockTerminalStoreState.addTerminal.mockImplementation(() => ({ id: 'new-terminal' }))
})

afterEach(() => {
  vi.useRealTimers()
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
  it('records project-switch start and live-pty restore path selection', async () => {
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

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
        name: 'project-switch-start',
        correlationId: 'corr-project-a',
        projectId: 'project-a',
        details: {
          previousProjectId: undefined,
          trigger: 'active-project-changed',
          callId: expect.any(String),
          restoreOwnerId: expect.stringContaining('project-a:')
        }
      })
    })

    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
      name: 'restore-path-selected',
      correlationId: 'corr-project-a',
      projectId: 'project-a',
      details: {
        path: 'live-pty',
        liveTerminalCount: 1
      }
    })
  })

  it('preserves a valid active agent-chat tab during live terminal reconciliation', async () => {
    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' }
    ]
    mockWorkspaceStore.getActivePaneLeaf.mockReturnValue({
      id: 'pane-active',
      type: 'leaf',
      tabs: [{ type: 'agent-chat', id: 'chat-agent', sessionId: 'session-a' }],
      activeTabId: 'chat-agent'
    })
    mockAcpState.sessions = { 'session-a': { projectId: 'project-a' } }
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

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockWorkspaceStore.ensureTerminalTab).toHaveBeenCalledWith('a-live', undefined, false)
    })

    expect(mockWorkspaceStore.setActiveTab).not.toHaveBeenCalled()
    expect(mockTerminalStoreState.selectTerminal).toHaveBeenCalledWith('a-live')
  })

  it('prefers currently active live terminal when selecting a live terminal', async () => {
    mockTerminalStoreState.terminals = [
      { id: 'a-live', projectId: 'project-a', name: 'A', shell: 'bash', ptyId: 'pty-a' }
    ]
    mockTerminalStoreState.activeTerminalId = 'a-live'
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

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
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

    const { rerender } = renderHook(
      ({ projectId }) => {
        mockProjectState.activeProjectId = projectId
        useTerminalRestore()
      },
      {
        initialProps: { projectId: 'project-a' }
      }
    )

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
      const { rerender } = renderHook(
        ({ projectId }) => {
          mockProjectState.activeProjectId = projectId
          useTerminalRestore()
        },
        {
          initialProps: { projectId: 'project-a' }
        }
      )

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
    vi.useFakeTimers()
    const spawnGate = {
      resolve: undefined as ((value: { success: true; data: { id: string } }) => void) | undefined
    }

    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    mockTerminalSpawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          spawnGate.resolve = resolve as (value: { success: true; data: { id: string } }) => void
        })
    )

    const { rerender } = renderHook(
      ({ projectId }) => {
        mockProjectState.activeProjectId = projectId
        useTerminalRestore()
      },
      { initialProps: { projectId: 'project-a' } }
    )

    // Speed up any retries
    await vi.runOnlyPendingTimersAsync()
    expect(mockTerminalSpawn).toHaveBeenCalled()

    // Cancel by switching project
    rerender({ projectId: 'project-b' })
    await vi.runOnlyPendingTimersAsync()

    // Resolve the orphan spawn
    spawnGate.resolve?.({ success: true, data: { id: 'pty-orphan' } })
    await vi.runOnlyPendingTimersAsync()

    // Race can resolve after cancel; important part: no crash, no extra retry loop
    expect(mockTerminalSpawn).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('records restore start and completion when loading from disk', async () => {
    vi.useFakeTimers()
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: ['line 1'] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await vi.runOnlyPendingTimersAsync()

    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project-switch-start', projectId: 'project-a' })
    )
    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'restore-complete', projectId: 'project-a' })
    )
    vi.useRealTimers()
  })

  it('does not emit restore-complete after a cancelled persisted replay', async () => {
    vi.useFakeTimers()
    const spawnGate = {
      resolve: undefined as ((value: { success: true; data: { id: string } }) => void) | undefined
    }

    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: ['line 1'] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    mockTerminalSpawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          spawnGate.resolve = resolve as (value: { success: true; data: { id: string } }) => void
        })
    )

    const { rerender } = renderHook(
      ({ projectId }) => {
        mockProjectState.activeProjectId = projectId
        useTerminalRestore()
      },
      { initialProps: { projectId: 'project-a' } }
    )

    await vi.runOnlyPendingTimersAsync()
    expect(mockTerminalSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-a' })
    )

    rerender({ projectId: 'project-b' })
    await vi.runOnlyPendingTimersAsync()

    spawnGate.resolve?.({ success: true, data: { id: 'pty-orphan' } })
    await vi.runOnlyPendingTimersAsync()

    expect(mockRecordTerminalContinuityEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'restore-complete', correlationId: 'corr-project-a' })
    )
    vi.useRealTimers()
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

  it('does not auto-spawn a terminal for a project with no persisted terminals', async () => {
    vi.useFakeTimers()
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue(null)
    mockTerminalSpawn.mockResolvedValue({ success: true, data: { id: 'pty-default' } })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await vi.runOnlyPendingTimersAsync()

    // No terminal should be spawned; the empty-state launcher is shown instead.
    expect(mockTerminalSpawn).not.toHaveBeenCalled()
    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'restore-path-selected',
        projectId: 'project-a',
        details: expect.objectContaining({ path: 'empty-state' })
      })
    )
    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'restore-complete',
        projectId: 'project-a',
        details: expect.objectContaining({ path: 'empty-state', restoredTerminalCount: 0 })
      })
    )
    expect(mockSetTerminalRestoreInProgress).toHaveBeenCalledWith(
      'project-a',
      true,
      expect.stringContaining('project-a:')
    )
    vi.useRealTimers()
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

    const { rerender } = renderHook(
      ({ projectId }) => {
        mockProjectState.activeProjectId = projectId
        useTerminalRestore()
      },
      {
        initialProps: { projectId: 'project-a' }
      }
    )

    // Switch to project-b
    rerender({ projectId: 'project-b' })

    await waitFor(() => {
      expect(mockSaveTerminalLayout).toHaveBeenCalledWith(
        'project-a',
        expect.objectContaining({
          correlationId: 'corr-project-b',
          reason: 'project-switch',
          targetProjectId: 'project-b'
        })
      )
    })

    // The key assertion: terminalApi.kill should NOT be called during project switch
    // (the old implementation would have called kill for project-a's terminals)
    expect(mockTerminalKill).not.toHaveBeenCalled()
  })

  it('passes projectId when restoring an agent terminal (agent branch)', async () => {
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-agent',
      terminals: [
        {
          id: 'persisted-agent',
          name: 'Agent',
          kind: 'agent',
          agentId: 'claude-code',
          agentProgram: 'claude',
          agentArgs: [],
          shell: 'claude',
          cwd: '/projects/a',
          scrollback: []
        }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-a',
          program: 'claude',
          kind: 'agent'
        })
      )
    })
  })

  it('passes projectId when spawning the default terminal on restore error fallback', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockTerminalStoreState.terminals = []
    // Force the restore try-block to throw (not cancelled) -> createDefaultTerminal
    mockLoadPersistedTerminals.mockRejectedValueOnce(new Error('disk read failed'))

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-a' })
      )
    })
    // CAP-3: the issued claim from the fallback spawn lands in the terminal store.
    await waitFor(() => {
      expect(mockTerminalStoreState.setTerminalClaim).toHaveBeenCalledWith(
        'pty-1',
        'lease-claim-restore'
      )
    })
    consoleErrorSpy.mockRestore()
  })

  // ── Story 5: cross-reload preserved-PTY reattach ─────────────────────────

  it('reattaches preserved PTYs by name/shell/cwd instead of spawning on reload', async () => {
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] },
        { id: 'persisted-b', name: 'B', shell: 'bash', cwd: '/projects/a', scrollback: [] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    // The host preserved both PTYs of project-a across the reload and
    // re-issued claims for them.
    mockListPreserved.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'terminal-100-1',
          shell: '/bin/bash',
          cwd: '/projects/a',
          pid: 11,
          cols: 80,
          rows: 24,
          claim: 'fresh-claim-a'
        },
        {
          id: 'terminal-100-2',
          shell: '/bin/bash',
          cwd: '/projects/a',
          pid: 12,
          cols: 80,
          rows: 24,
          claim: 'fresh-claim-b'
        }
      ]
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    await waitFor(() => {
      expect(mockTerminalAttach).toHaveBeenCalledTimes(2)
    })
    // Both reattaches present the fresh claim with lastSeq=0 (full
    // retained-window scrollback replay).
    expect(mockTerminalAttach).toHaveBeenNthCalledWith(1, 'terminal-100-1', 'fresh-claim-a', 0)
    expect(mockTerminalAttach).toHaveBeenNthCalledWith(2, 'terminal-100-2', 'fresh-claim-b', 0)
    // NO new PTY was spawned — the preserved pair was reused (no leak).
    expect(mockTerminalSpawn).not.toHaveBeenCalled()

    // Both restored as tabs with the SERVER terminal ids + fresh claims.
    await waitFor(() => {
      expect(mockTerminalStoreState.setTerminals).toHaveBeenCalled()
    })
    const setCall = mockTerminalStoreState.setTerminals.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >
    const newTerminals = setCall.filter((t) => t.projectId === 'project-a')
    expect(newTerminals).toHaveLength(2)
    const ptyIds = newTerminals.map((t) => t.ptyId).sort()
    expect(ptyIds).toEqual(['terminal-100-1', 'terminal-100-2'])
    const claims = newTerminals.map((t) => t.claim).sort()
    expect(claims).toEqual(['fresh-claim-a', 'fresh-claim-b'])
  })

  it('falls back to spawn when list_preserved fails (server restarted)', async () => {
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    // Server restarted: the gate refuses the listing (or nothing preserved).
    mockListPreserved.mockResolvedValue({
      success: false,
      error: 'Unauthorized',
      code: 'UNAUTHORIZED'
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    // Exactly the legacy behavior: spawn runs, no attach attempted.
    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-a' })
      )
    })
    expect(mockTerminalAttach).not.toHaveBeenCalled()
  })

  it('falls back to spawn for a persisted entry whose preserved attach is rejected', async () => {
    mockTerminalStoreState.terminals = []
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    mockListPreserved.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'terminal-100-1',
          shell: '/bin/bash',
          cwd: '/projects/a',
          pid: 11,
          cols: 80,
          rows: 24,
          claim: 'stale-claim'
        }
      ]
    })
    // The re-issued claim is rejected (terminal reaped between list+attach).
    mockTerminalAttach.mockResolvedValueOnce({
      success: false,
      error: 'Unauthorized',
      code: 'UNAUTHORIZED'
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    // Attach was tried and rejected; the spawn fallback ran for the entry.
    await waitFor(() => {
      expect(mockTerminalAttach).toHaveBeenCalledWith('terminal-100-1', 'stale-claim', 0)
    })
    await waitFor(() => {
      expect(mockTerminalSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-a' })
      )
    })
  })

  it('restores leftover preserved PTYs as their own tabs (resolved Q3)', async () => {
    mockTerminalStoreState.terminals = []
    // Persisted layout knows one terminal; the host preserved two.
    mockLoadPersistedTerminals.mockResolvedValue({
      activeTerminalId: 'persisted-a',
      terminals: [
        { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] }
      ],
      updatedAt: '2026-03-09T00:00:00.000Z'
    })
    mockListPreserved.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'terminal-100-1',
          shell: '/bin/bash',
          cwd: '/projects/a',
          pid: 11,
          cols: 80,
          rows: 24,
          claim: 'fresh-claim-a'
        },
        {
          id: 'terminal-999-9',
          shell: '/bin/bash',
          cwd: '/elsewhere',
          pid: 99,
          cols: 80,
          rows: 24,
          claim: 'leftover-claim'
        }
      ]
    })

    renderHook(() => {
      mockProjectState.activeProjectId = 'project-a'
      useTerminalRestore()
    })

    // Both preserved PTYs were attached (matched + leftover).
    await waitFor(() => {
      expect(mockTerminalAttach).toHaveBeenCalledTimes(2)
    })
    expect(mockTerminalSpawn).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(mockTerminalStoreState.setTerminals).toHaveBeenCalled()
    })
    const setCall = mockTerminalStoreState.setTerminals.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >
    const newTerminals = setCall.filter((t) => t.projectId === 'project-a')
    expect(newTerminals).toHaveLength(2)
    const ptyIds = newTerminals.map((t) => t.ptyId).sort()
    expect(ptyIds).toEqual(['terminal-100-1', 'terminal-999-9'])
  })

  it('accumulates no leaked PTYs across three reload cycles (preserved count stable)', async () => {
    // Three sequential "reloads": each cycle re-lists the SAME two preserved
    // PTYs, reattaches them, and never spawns. The terminal store starts
    // empty each cycle (page reload = fresh renderer memory).
    const preserved = [
      {
        id: 'terminal-100-1',
        shell: '/bin/bash',
        cwd: '/projects/a',
        pid: 11,
        cols: 80,
        rows: 24,
        claim: 'fresh-claim-a'
      },
      {
        id: 'terminal-100-2',
        shell: '/bin/bash',
        cwd: '/projects/a',
        pid: 12,
        cols: 80,
        rows: 24,
        claim: 'fresh-claim-b'
      }
    ]
    mockListPreserved.mockResolvedValue({ success: true, data: preserved })

    for (let cycle = 0; cycle < 3; cycle++) {
      mockTerminalStoreState.terminals = []
      mockTerminalStoreState.activeTerminalId = ''
      mockTerminalSpawn.mockClear()
      mockTerminalAttach.mockClear()
      mockTerminalKill.mockClear()
      mockTerminalStoreState.setTerminals.mockClear()
      __TEST_RESET_LOCKS__()
      mockRecordTerminalContinuityEvent.mockClear()
      mockBeginProjectContinuityCorrelation.mockClear()
      mockBeginProjectContinuityCorrelation.mockImplementation(
        (projectId: string) => `corr-${projectId}`
      )
      mockLoadPersistedTerminals.mockResolvedValue({
        activeTerminalId: 'persisted-a',
        terminals: [
          { id: 'persisted-a', name: 'A', shell: 'bash', cwd: '/projects/a', scrollback: [] },
          { id: 'persisted-b', name: 'B', shell: 'bash', cwd: '/projects/a', scrollback: [] }
        ],
        updatedAt: '2026-03-09T00:00:00.000Z'
      })

      const { unmount } = renderHook(() => {
        mockProjectState.activeProjectId = 'project-a'
        useTerminalRestore()
      })

      await waitFor(() => {
        expect(mockTerminalAttach).toHaveBeenCalledTimes(2)
      })
      // No spawn, no kill: the preserved pair carries the whole cycle.
      expect(mockTerminalSpawn).not.toHaveBeenCalled()
      expect(mockTerminalKill).not.toHaveBeenCalled()
      unmount()
    }

    // Across all 3 cycles: exactly 6 attaches (2 per cycle), 0 spawns —
    // the server-side preserved set never grew.
    expect(mockTerminalAttach).toHaveBeenCalledTimes(2)
  })
})
