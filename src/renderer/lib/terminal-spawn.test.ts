/**
 * Unit tests for spawnTerminalInPane shared spawn logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist mocks so they're available when vi.mock factories run
const {
  mockAddTerminal,
  mockSetTerminalPtyId,
  mockSetTerminalClaim,
  mockIsTerminalLimitReached,
  mockAddTabToPane,
  mockTerminalApiSpawn,
  mockTerminals,
  mockSetActiveWorktree,
  mockActivePaneId
} = vi.hoisted(() => ({
  mockAddTerminal: vi.fn(),
  mockSetTerminalPtyId: vi.fn(),
  mockSetTerminalClaim: vi.fn(),
  mockIsTerminalLimitReached: vi.fn(),
  mockAddTabToPane: vi.fn(),
  mockTerminalApiSpawn: vi.fn(),
  mockTerminals: [] as Array<{ projectId: string }>,
  mockSetActiveWorktree: vi.fn(),
  // Mutable so the no-pane branch can be exercised without re-registering the
  // workspace-store mock. Defaults to an active pane so existing tests pass.
  mockActivePaneId: { current: 'pane-1' as string | null }
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      terminals: mockTerminals,
      addTerminal: mockAddTerminal,
      setTerminalPtyId: mockSetTerminalPtyId,
      setTerminalClaim: mockSetTerminalClaim,
      isTerminalLimitReached: mockIsTerminalLimitReached
    })
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      activePaneId: mockActivePaneId.current,
      addTabToPane: mockAddTabToPane
    })
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: 'proj-1', name: 'Test', path: '/test', defaultShell: 'bash', envVars: [] }],
      setActiveWorktree: mockSetActiveWorktree
    })
  }
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppSettingsStore: {
    getState: () => ({ settings: { maxTerminalsPerProject: 10 } })
  }
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: mockTerminalApiSpawn
  }
}))

vi.mock('@/lib/env-parser', () => ({
  resolveEnvForSpawn: () => ({ env: {}, hasProjectEnv: false })
}))

import { openTerminalAtCwd, spawnTerminalInPane } from '@/lib/terminal-spawn'

describe('spawnTerminalInPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTerminals.length = 0
    mockActivePaneId.current = 'pane-1'
    mockIsTerminalLimitReached.mockReturnValue(false)
    mockAddTerminal.mockReturnValue({ id: 'term-new-1' })
    // CAP-3: spawn is the only claim issuance path — the fixture carries the
    // issued lease credential alongside the terminal info.
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', shell: 'bash', cwd: '/test/worktree', claim: 'claim-pty-1' }
    })
  })

  it('spawns a terminal in the specified pane with full cycle', async () => {
    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(result.success).toBe(true)
    expect(result.terminalId).toBe('term-new-1')
    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/worktree' })
    )
    expect(mockAddTerminal).toHaveBeenCalled()
    expect(mockSetTerminalPtyId).toHaveBeenCalledWith('term-new-1', 'pty-1')
    // CAP-3: the issued claim is stored on the terminal record via the
    // spawned pty id.
    expect(mockSetTerminalClaim).toHaveBeenCalledWith('pty-1', 'claim-pty-1')
    expect(mockAddTabToPane).toHaveBeenCalledWith('pane-1', {
      type: 'terminal',
      id: 'term-term-new-1',
      terminalId: 'term-new-1'
    })
  })

  it('does not store a claim when the spawn response omits one', async () => {
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-no-claim', shell: 'bash', cwd: '/test/worktree' }
    })

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(result.success).toBe(true)
    expect(mockSetTerminalPtyId).toHaveBeenCalledWith('term-new-1', 'pty-no-claim')
    expect(mockSetTerminalClaim).not.toHaveBeenCalled()
  })

  it('returns error when global terminal limit is reached', async () => {
    mockIsTerminalLimitReached.mockReturnValue(true)

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Maximum')
    expect(mockTerminalApiSpawn).not.toHaveBeenCalled()
    expect(mockAddTerminal).not.toHaveBeenCalled()
  })

  it('returns error when per-project terminal limit is reached', async () => {
    // 10 terminals already in this project
    for (let i = 0; i < 10; i++) {
      mockTerminals.push({ projectId: 'proj-1' })
    }

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree', {
      maxTerminalsPerProject: 10
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Maximum 10 terminals per project')
    expect(mockTerminalApiSpawn).not.toHaveBeenCalled()
  })

  it('allows spawn when under per-project limit', async () => {
    // 9 terminals in this project (limit is 10)
    for (let i = 0; i < 9; i++) {
      mockTerminals.push({ projectId: 'proj-1' })
    }

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree', {
      maxTerminalsPerProject: 10
    })

    expect(result.success).toBe(true)
  })

  it('per-project limit only counts terminals for same project', async () => {
    // 10 terminals in a different project
    for (let i = 0; i < 10; i++) {
      mockTerminals.push({ projectId: 'proj-other' })
    }

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree', {
      maxTerminalsPerProject: 10
    })

    expect(result.success).toBe(true)
  })

  it('returns error when PTY spawn fails', async () => {
    mockTerminalApiSpawn.mockResolvedValue({
      success: false,
      error: 'Shell not found'
    })

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Shell not found')
    expect(mockAddTerminal).not.toHaveBeenCalled()
    expect(mockAddTabToPane).not.toHaveBeenCalled()
  })

  it('passes explicit shell option when provided', async () => {
    await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree', {
      shell: 'zsh'
    })

    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(expect.objectContaining({ shell: 'zsh' }))
  })

  it('passes projectId into the spawn payload (web server requires non-empty projectId)', async () => {
    await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' })
    )
  })

  it('resolves shell from project default when no explicit shell', async () => {
    await spawnTerminalInPane('pane-1', 'proj-1', '/test/worktree')

    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(expect.objectContaining({ shell: 'bash' }))
  })

  it('returns error when PTY spawn returns no data with empty error', async () => {
    mockTerminalApiSpawn.mockResolvedValue({
      success: false,
      error: ''
    })

    const result = await spawnTerminalInPane('pane-1', 'proj-1', '/test')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Failed to create terminal')
  })
})

describe('openTerminalAtCwd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTerminals.length = 0
    mockActivePaneId.current = 'pane-1'
    mockIsTerminalLimitReached.mockReturnValue(false)
    mockAddTerminal.mockReturnValue({ id: 'term-new-1' })
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', shell: 'bash', cwd: '/chat/cwd', claim: 'claim-pty-1' }
    })
  })

  it('opens a terminal at the given cwd WITHOUT syncing activeWorktreeId', async () => {
    const result = await openTerminalAtCwd('proj-1', '/chat/cwd')

    expect(result.status).toBe('opened')
    if (result.status === 'opened') {
      expect(result.terminalId).toBe('term-new-1')
    }
    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/chat/cwd', projectId: 'proj-1' })
    )
    expect(mockAddTabToPane).toHaveBeenCalledWith(
      'pane-1',
      expect.objectContaining({ type: 'terminal' })
    )
    // The chat terminal path must NOT touch the active worktree — that is the
    // user's "make this the active chat" gesture, not a worktree switch.
    expect(mockSetActiveWorktree).not.toHaveBeenCalled()
  })

  it('returns no-pane when there is no active workspace pane', async () => {
    mockActivePaneId.current = null

    const result = await openTerminalAtCwd('proj-1', '/chat/cwd')

    expect(result).toEqual({ status: 'no-pane' })
    expect(mockTerminalApiSpawn).not.toHaveBeenCalled()
    expect(mockSetActiveWorktree).not.toHaveBeenCalled()
  })

  it('returns spawn-failed (without syncing active worktree) when spawn fails', async () => {
    mockTerminalApiSpawn.mockResolvedValue({ success: false, error: 'Shell not found' })

    const result = await openTerminalAtCwd('proj-1', '/chat/cwd')

    expect(result).toEqual({ status: 'spawn-failed', error: 'Shell not found' })
    expect(mockSetActiveWorktree).not.toHaveBeenCalled()
  })
})
