/**
 * Unit tests for launchAgentInPane orchestration (ADR-004.4).
 *
 * Verifies the agent is spawned with program/args/kind:'agent', the prompt is
 * passed as a discrete arg (never interpolated), the terminal is tagged with
 * descriptive agent metadata, and the seed prompt is NOT stored on the record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
	mockAddTerminal,
	mockSetTerminalPtyId,
	mockSetTerminalAgentMetadata,
	mockIsTerminalLimitReached,
	mockAddTabToPane,
	mockTerminalApiSpawn,
	mockEnsureWorktreeSymlinks,
	mockTerminals,
} = vi.hoisted(() => ({
	mockAddTerminal: vi.fn(),
	mockSetTerminalPtyId: vi.fn(),
	mockSetTerminalAgentMetadata: vi.fn(),
	mockIsTerminalLimitReached: vi.fn(),
	mockAddTabToPane: vi.fn(),
	mockTerminalApiSpawn: vi.fn(),
	mockEnsureWorktreeSymlinks: vi.fn(),
	mockTerminals: [] as Array<{ projectId: string }>,
}))

vi.mock('@/stores/terminal-store', () => ({
	useTerminalStore: {
		getState: () => ({
			terminals: mockTerminals,
			addTerminal: mockAddTerminal,
			setTerminalPtyId: mockSetTerminalPtyId,
			setTerminalAgentMetadata: mockSetTerminalAgentMetadata,
			isTerminalLimitReached: mockIsTerminalLimitReached,
		}),
	},
}))

vi.mock('@/stores/workspace-store', () => ({
	useWorkspaceStore: {
		getState: () => ({
			activePaneId: 'pane-1',
			addTabToPane: mockAddTabToPane,
		}),
	},
}))

vi.mock('@/stores/project-store', () => ({
	useProjectStore: {
		getState: () => ({
			projects: [{ id: 'proj-1', name: 'Test', path: '/test', envVars: [] }],
		}),
	},
}))

vi.mock('@/stores/app-settings-store', () => ({
	useAppSettingsStore: {
		getState: () => ({ settings: { maxTerminalsPerProject: 10 } }),
	},
}))

vi.mock('@/lib/api', () => ({
	terminalApi: { spawn: mockTerminalApiSpawn },
}))

vi.mock('@/lib/env-parser', () => ({
	resolveEnvForSpawn: () => ({ env: {}, hasProjectEnv: false }),
}))

vi.mock('@/lib/worktree-context', () => ({
	ensureWorktreeSymlinks: mockEnsureWorktreeSymlinks,
}))

import { launchAgentInPane } from '@/lib/agent-launch'
import { getBuiltInAgent } from '@/lib/agents/agent-registry'

const claude = getBuiltInAgent('claude-code')!
const gemini = getBuiltInAgent('gemini-cli')!

describe('launchAgentInPane', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockTerminals.length = 0
		mockIsTerminalLimitReached.mockReturnValue(false)
		mockAddTerminal.mockReturnValue({ id: 'term-new-1' })
		mockTerminalApiSpawn.mockResolvedValue({
			success: true,
			data: { id: 'pty-1', shell: 'claude', cwd: '/test' },
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
				kind: 'agent',
			}),
		)
	})

	it('uses the flag form for gemini', async () => {
		await launchAgentInPane('pane-1', 'proj-1', '/test', gemini, 'query')
		expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
			expect.objectContaining({ program: 'gemini', args: ['-i', 'query'], kind: 'agent' }),
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
		expect(mockSetTerminalAgentMetadata).toHaveBeenCalledWith('term-new-1', {
			agentId: 'claude-code',
			agentName: 'Claude Code',
			agentProgram: 'claude',
			agentArgs: [],
		})
		// The seed prompt must not be persisted in metadata (restore caveat).
		const meta = mockSetTerminalAgentMetadata.mock.calls[0][1]
		expect(JSON.stringify(meta)).not.toContain('do a thing')
	})

	it('names the terminal after the agent and adds a tab', async () => {
		await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x')
		expect(mockAddTerminal).toHaveBeenCalledWith('Claude Code', 'proj-1', 'claude', '/test')
		expect(mockSetTerminalPtyId).toHaveBeenCalledWith('term-new-1', 'pty-1')
		expect(mockAddTabToPane).toHaveBeenCalledWith(
			'pane-1',
			expect.objectContaining({ type: 'terminal', terminalId: 'term-new-1' }),
		)
	})

	it('launches with no prompt (none mode) for pi', async () => {
		const pi = getBuiltInAgent('pi')!
		await launchAgentInPane('pane-1', 'proj-1', '/test', pi, 'ignored prompt')
		expect(mockTerminalApiSpawn).toHaveBeenCalledWith(
			expect.objectContaining({ program: 'pi', args: [], kind: 'agent' }),
		)
	})

	it('blocks when the per-project terminal limit is reached', async () => {
		mockTerminals.push({ projectId: 'proj-1' }, { projectId: 'proj-1' })
		const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x', {
			maxTerminalsPerProject: 2,
		})
		expect(result.success).toBe(false)
		expect(mockTerminalApiSpawn).not.toHaveBeenCalled()
	})

	it('surfaces a spawn failure as a result error', async () => {
		mockTerminalApiSpawn.mockResolvedValue({ success: false, error: 'no binary' })
		const result = await launchAgentInPane('pane-1', 'proj-1', '/test', claude, 'x')
		expect(result.success).toBe(false)
		expect(result.error).toBe('no binary')
		expect(mockAddTerminal).not.toHaveBeenCalled()
	})
})
