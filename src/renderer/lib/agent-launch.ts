/**
 * ADR-004.4: Launch orchestration for terminal-native CLI agents.
 *
 * Sibling of `terminal-spawn.ts`. Reuses the same store-read / limit / env /
 * symlink mechanics, differing only in: building the agent argv from the Agent
 * Registry, passing `program`/`args`/`kind:'agent'` to the spawn primitive
 * (ADR-004.2), and tagging the created Terminal record with descriptive-only
 * agent metadata (ADR-004.4).
 *
 * The user's prompt is delivered to the PTY as a discrete argv element and is
 * NEVER shell-interpolated — the Rust spawn path (argv on POSIX, audited
 * command-line quoting on Windows) guarantees this.
 */

import { terminalApi } from '@/lib/api'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ensureWorktreeSymlinks } from '@/lib/worktree-context'
import { buildAgentArgv, type TerminalAgentDefinition } from '@/lib/agents/agent-registry'

export interface LaunchAgentOptions {
	/** Project environment variables for spawn. */
	envVars?: Array<{ key: string; value: string; enabled?: boolean }>
	/** Per-project terminal limit. Spawns are blocked at this count. */
	maxTerminalsPerProject?: number
}

export interface LaunchAgentResult {
	success: boolean
	error?: string
	terminalId?: string
}

/**
 * Launch a CLI agent's interactive TUI in a specific workspace pane.
 *
 * Reads stores via getState() at call time. Returns a result object so callers
 * decide how to surface errors. On success the pane gains a terminal tab whose
 * foreground process is the agent binary, seeded with `prompt`.
 */
export async function launchAgentInPane(
	paneId: string,
	projectId: string,
	cwd: string,
	def: TerminalAgentDefinition,
	prompt: string | undefined,
	options?: LaunchAgentOptions,
): Promise<LaunchAgentResult> {
	const terminalStore = useTerminalStore.getState()
	const workspaceStore = useWorkspaceStore.getState()

	// Per-project terminal limit (mirrors spawnTerminalInPane).
	if (options?.maxTerminalsPerProject !== undefined) {
		const projectTerminalCount = terminalStore.terminals.filter(
			(t) => t.projectId === projectId,
		).length
		if (projectTerminalCount >= options.maxTerminalsPerProject) {
			return {
				success: false,
				error: `Maximum ${options.maxTerminalsPerProject} terminals per project`,
			}
		}
	}

	// Global terminal limit.
	if (terminalStore.isTerminalLimitReached()) {
		return {
			success: false,
			error: `Maximum ${terminalStore.terminals.length} terminals allowed across all projects`,
		}
	}

	const project = useProjectStore.getState().projects.find((p) => p.id === projectId)

	try {
		// Ensure worktree symlinks are present when launching into a worktree path.
		if (project?.worktrees?.some((w) => w.path === cwd)) {
			await ensureWorktreeSymlinks(projectId)
		}

		// Resolve project env vars for spawn (same as terminal spawn).
		const { env: projectEnv, hasProjectEnv } = resolveEnvForSpawn(
			options?.envVars ?? project?.envVars,
			{},
		)

		// Merge any agent-declared env on top of project env. Values may reference
		// an existing var with a leading `$` (resolved against the project env).
		const agentEnv = resolveAgentEnv(def.env, projectEnv)
		const mergedEnv = { ...projectEnv, ...agentEnv }
		const hasEnv = hasProjectEnv || Object.keys(agentEnv).length > 0

		// Build argv from the registry definition + prompt (pure, injection-safe).
		const { program, args } = buildAgentArgv(def, prompt)

		const spawnResult = await terminalApi.spawn({
			cwd,
			program,
			args,
			kind: 'agent',
			...(hasEnv ? { env: mergedEnv } : {}),
		})

		if (!spawnResult.success) {
			return {
				success: false,
				error: spawnResult.error || 'Failed to launch agent',
			}
		}

		// Create the terminal record. Name defaults to the agent name so the tab
		// reads e.g. "Claude Code" instead of "Terminal 3".
		//
		// CRITICAL: Batch all terminal store mutations into a single set() call to
		// prevent intermediate Zustand subscriptions from firing syncTerminalTabs
		// before the terminal has a ptyId or the tab has been added to the pane.
		// The old approach (addTerminal → setTerminalAgentMetadata → setTerminalPtyId)
		// triggered 3+ separate re-renders, each one making the terminal look
		// "orphaned" to syncTerminalTabs, which removed the tab and cascaded into
		// a MOUNT/UNMOUNT storm.
		const terminalId = Date.now().toString()
		const agentArgsCopy = [...def.baseArgs]

		terminalStore.setTerminals([
			...terminalStore.terminals,
			{
				id: terminalId,
				name: def.name,
				projectId,
				shell: program,
				cwd,
				output: [],
				healthStatus: 'running',
				isHidden: false,
				ptyId: spawnResult.data.id,
				// ADR-004.4: descriptive-only agent metadata
				kind: 'agent',
				agentId: def.id,
				agentName: def.name,
				agentProgram: program,
				agentArgs: agentArgsCopy,
			},
		])

		// Select the new terminal.
		terminalStore.selectTerminal(terminalId)

		// Add terminal tab to the workspace pane.
		workspaceStore.addTabToPane(paneId, {
			type: 'terminal',
			id: `term-${terminalId}`,
			terminalId,
		})

		return { success: true, terminalId }
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Resolve an agent definition's env map. A value of the form `$NAME` is replaced
 * with the value of `NAME` from the surrounding env (project env or, as a
 * fallback, an empty string). Plain values pass through unchanged. Entries that
 * resolve to empty are dropped so we never inject blank API keys.
 */
function resolveAgentEnv(
	defEnv: Record<string, string> | undefined,
	surroundingEnv: Record<string, string>,
): Record<string, string> {
	if (!defEnv) return {}
	const out: Record<string, string> = {}
	for (const [key, raw] of Object.entries(defEnv)) {
		if (!key.trim()) continue
		let value = raw
		if (raw.startsWith('$')) {
			value = surroundingEnv[raw.slice(1)] ?? ''
		}
		if (value !== '') {
			out[key] = value
		}
	}
	return out
}

/**
 * Convenience wrapper mirroring `activateAndOpenTerminal`: reads the active pane
 * and per-project limit from stores, then launches the agent. Used by the
 * launcher UI and command bar.
 */
export async function launchAgentInActivePane(
	projectId: string,
	cwd: string,
	def: TerminalAgentDefinition,
	prompt: string | undefined,
): Promise<LaunchAgentResult> {
	const paneId = useWorkspaceStore.getState().activePaneId
	if (!paneId) {
		return { success: false, error: 'No active pane' }
	}

	const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
	const maxTerminalsPerProject = useAppSettingsStore.getState().settings.maxTerminalsPerProject

	return launchAgentInPane(paneId, projectId, cwd, def, prompt, {
		envVars: project?.envVars,
		maxTerminalsPerProject,
	})
}
