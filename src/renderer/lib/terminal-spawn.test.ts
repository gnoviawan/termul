/**
 * Unit tests for spawnTerminalInPane shared spawn logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist mocks so they're available when vi.mock factories run
const {
  mockAddTerminal,
  mockSetTerminalPtyId,
  mockIsTerminalLimitReached,
  mockAddTabToPane,
  mockTerminalApiSpawn,
  mockTerminals
} = vi.hoisted(() => ({
  mockAddTerminal: vi.fn(),
  mockSetTerminalPtyId: vi.fn(),
  mockIsTerminalLimitReached: vi.fn(),
  mockAddTabToPane: vi.fn(),
  mockTerminalApiSpawn: vi.fn(),
  mockTerminals: [] as Array<{ projectId: string }>
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      terminals: mockTerminals,
      addTerminal: mockAddTerminal,
      setTerminalPtyId: mockSetTerminalPtyId,
      isTerminalLimitReached: mockIsTerminalLimitReached
    })
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      activePaneId: 'pane-1',
      addTabToPane: mockAddTabToPane
    })
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: 'proj-1', name: 'Test', path: '/test', defaultShell: 'bash', envVars: [] }]
    })
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

import { spawnTerminalInPane } from '@/lib/terminal-spawn'

describe('spawnTerminalInPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTerminals.length = 0
    mockIsTerminalLimitReached.mockReturnValue(false)
    mockAddTerminal.mockReturnValue({ id: 'term-new-1' })
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', shell: 'bash', cwd: '/test/worktree' }
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
    expect(mockAddTabToPane).toHaveBeenCalledWith('pane-1', {
      type: 'terminal',
      id: 'term-term-new-1',
      terminalId: 'term-new-1'
    })
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
