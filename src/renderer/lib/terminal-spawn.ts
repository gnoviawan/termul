/**
 * Shared terminal spawn logic for creating a new terminal in a workspace pane.
 *
 * Encapsulates the full spawn cycle: PTY spawn → addTerminal → setTerminalPtyId → addTabToPane.
 * Used by WorkspaceLayout, ProjectSidebar, and any future component that needs to
 * open a terminal without duplicating the spawn pipeline.
 */

import { terminalApi } from '@/lib/api'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ensureWorktreeSymlinks } from '@/lib/worktree-context'

export interface SpawnTerminalOptions {
	/** Shell path/name. If omitted, resolves from project default → app default. */
	shell?: string
	/** Project environment variables for spawn. */
	envVars?: Array<{ key: string; value: string; enabled?: boolean }>
	/** Per-project terminal limit. If set, spawns are blocked when the project's terminal count reaches this value. */
	maxTerminalsPerProject?: number
}

export interface SpawnTerminalResult {
	success: boolean
	error?: string
	terminalId?: string
}

/**
 * Spawn a new terminal in a specific workspace pane.
 *
 * Reads from stores via getState() at call time — no reactive subscriptions.
 * Returns a result object so callers can decide how to surface errors.
 */
export async function spawnTerminalInPane(
	paneId: string,
	projectId: string,
	cwd: string,
	options?: SpawnTerminalOptions,
): Promise<SpawnTerminalResult> {
	const terminalStore = useTerminalStore.getState()
	const workspaceStore = useWorkspaceStore.getState()

	// Check per-project terminal limit
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

	// Check global terminal limit
	if (terminalStore.isTerminalLimitReached()) {
		return {
			success: false,
			error: `Maximum ${terminalStore.terminals.length} terminals allowed across all projects`,
		}
	}

	// Resolve shell: explicit → project default → app default → undefined (backend picks)
	const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
	const shell = options?.shell ?? project?.defaultShell ?? undefined

	// Ensure worktree symlinks are present when spawning into a worktree path
	if (project?.worktrees?.some((w) => w.path === cwd)) {
		await ensureWorktreeSymlinks(projectId)
	}

	// Resolve project env vars for spawn
	const { env, hasProjectEnv } = resolveEnvForSpawn(options?.envVars ?? project?.envVars, {})

	const spawnResult = await terminalApi.spawn({
		shell,
		cwd,
		...(hasProjectEnv ? { env } : {}),
	})

	if (!spawnResult.success) {
		return {
			success: false,
			error: spawnResult.error || 'Failed to create terminal',
		}
	}

	// Create terminal record in store
	const terminalCount = terminalStore.terminals.length
	const terminal = terminalStore.addTerminal(
		`Terminal ${terminalCount + 1}`,
		projectId,
		shell,
		cwd,
	)

	// Link PTY ID to terminal record
	terminalStore.setTerminalPtyId(terminal.id, spawnResult.data.id)

	// Add terminal tab to the workspace pane
	workspaceStore.addTabToPane(paneId, {
		type: 'terminal',
		id: `term-${terminal.id}`,
		terminalId: terminal.id,
	})

	return {
		success: true,
		terminalId: terminal.id,
	}
}