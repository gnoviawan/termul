/**
 * Unit tests for launchAgentInPane orchestration (ADR-004.4).
 *
 * Verifies the agent is spawned with program/args/kind:'agent', the prompt is
 * passed as a discrete arg (never interpolated), the terminal is tagged with
 * descriptive agent metadata, and the seed prompt is NOT stored on the record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSetTerminals,
  mockSelectTerminal,
  mockIsTerminalLimitReached,
  mockAddTabToPane,
  mockTerminalApiSpawn,
  mockEnsureWorktreeSymlinks,
  mockTerminals
} = vi.hoisted(() => ({
  mockSetTerminals: vi.fn(),
  mockSelectTerminal: vi.fn(),
  mockIsTerminalLimitReached: vi.fn(),
  mockAddTabToPane: vi.fn(),
  mockTerminalApiSpawn: vi.fn(),
  mockEnsureWorktreeSymlinks: vi.fn(),
  mockTerminals: [] as Array<{ projectId: string }>
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({
      terminals: mockTerminals,
      setTerminals: mockSetTerminals,
      selectTerminal: mockSelectTerminal,
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
      projects: [{ id: 'proj-1', name: 'Test', path: '/test', envVars: [] }]
    })
  }
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppSettingsStore: {
    getState: () => ({ settings: { maxTerminalsPerProject: 10 } })
  }
}))

vi.mock('@/lib/api', () => ({
  terminalApi: { spawn: mockTerminalApiSpawn }
}))

vi.mock('@/lib/env-parser', () => ({
  resolveEnvForSpawn: () => ({ env: {}, hasProjectEnv: false })
}))

vi.mock('@/lib/worktree-context', () => ({
  ensureWorktreeSymlinks: mockEnsureWorktreeSymlinks
}))

import { launchAgentInPane } from '@/lib/agent-launch'
import { getBuiltInAgent } from '@/lib/agents/agent-registry'

const claude = getBuiltInAgent('claude-code')!
const gemini = getBuiltInAgent('gemini-cli')!

function lastCreatedTerminal(): Record<string, unknown> {
  const batch = mockSetTerminals.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>
  return batch[batch.length - 1]
}

describe('launchAgentInPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTerminals.length = 0
    mockIsTerminalLimitReached.mockReturnValue(false)
    mockTerminalApiSpawn.mockResolvedValue({
      success: true,
      data: { id: 'pty-1', shell: 'claude', cwd: '/test' }
    })
  })

  it('spawns with program/args/kind:agent and a positional prompt', async () => {
    const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'explain this')
    expect(result.success).toBe(true)
    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/test',
        program: 'claude',
        args: ['explain this'],
        kind: 'agent'
      })
    )
  })

  it('uses the flag form for gemini', async () => {
    await launchAgentInPane('pane-1', 'proj-1', '/test', gemini, 'query')
    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'gemini', args: ['-i', 'query'], kind: 'agent' })
    )
  })

  it('passes a dangerous prompt as a single discrete arg', async () => {
    const dangerous = '"; rm -rf ~ # `whoami`'
    await launchAgentInPane('pane-1', 'proj-1', '/test', claude, dangerous)
    const opts = mockTerminalApiSpawn.mock.calls[0][0]
    expect(opts.args).toEqual([dangerous])
  })

  it('tags the terminal with agent metadata excluding the seed prompt', async () => {
    await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'do a thing')
    expect(mockSetTerminals).toHaveBeenCalled()
    expect(lastCreatedTerminal()).toMatchObject({
      kind: 'agent',
      agentId: 'claude-code',
      agentName: 'Claude Code',
      agentProgram: 'claude',
      agentArgs: [],
      ptyId: 'pty-1'
    })
    expect(JSON.stringify(lastCreatedTerminal())).not.toContain('do a thing')
  })

  it('names the terminal after the agent, selects it, and adds a tab', async () => {
    const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x')
    expect(result.terminalId).toBeTruthy()
    expect(lastCreatedTerminal()).toMatchObject({
      name: 'Claude Code',
      projectId: 'proj-1',
      shell: 'claude',
      cwd: '/test'
    })
    expect(mockSelectTerminal).toHaveBeenCalledWith(result.terminalId)
    expect(mockAddTabToPane).toHaveBeenCalledWith(
      'pane-1',
      expect.objectContaining({ type: 'terminal', terminalId: result.terminalId })
    )
  })

  it('passes the prompt positionally for pi', async () => {
    const pi = getBuiltInAgent('pi')!
    await launchAgentInPane('pane-1', 'proj-1', '/test', pi, 'ignored prompt')
    expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'pi', args: ['ignored prompt'], kind: 'agent' })
    )
  })

  it('blocks when the per-project terminal limit is reached', async () => {
    mockTerminals.push({ projectId: 'proj-1' }, { projectId: 'proj-1' })
    const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x', {
      maxTerminalsPerProject: 2
    })
    expect(result.success).toBe(false)
    expect(mockTerminalApiSpawn).not.toHaveBeenCalled()
  })

  it('surfaces a spawn failure as a result error', async () => {
    mockTerminalApiSpawn.mockResolvedValue({ success: false, error: 'no binary' })
    const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x')
    expect(result.success).toBe(false)
    expect(result.error).toBe('no binary')
    expect(mockSetTerminals).not.toHaveBeenCalled()
  })
})
