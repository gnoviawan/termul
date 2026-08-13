/**
 * Shared terminal spawn logic for creating a new terminal in a workspace pane.
 *
 * Encapsulates the full spawn cycle: PTY spawn → addTerminal → setTerminalPtyId → addTabToPane.
 * Used by WorkspaceLayout, ProjectSidebar, and any future component that needs to
 * open a terminal without duplicating the spawn pipeline.
 */

import { terminalApi } from '@/lib/api'
import { resolveEnvForSpawn } from '@/lib/env-parser'
import { logFrontendError } from '@/lib/log-api'
import { ensureWorktreeSymlinks } from '@/lib/worktree-context'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

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
  options?: SpawnTerminalOptions
): Promise<SpawnTerminalResult> {
  const terminalStore = useTerminalStore.getState()
  const workspaceStore = useWorkspaceStore.getState()

  // Check per-project terminal limit
  if (options?.maxTerminalsPerProject !== undefined) {
    const projectTerminalCount = terminalStore.terminals.filter(
      (t) => t.projectId === projectId
    ).length
    if (projectTerminalCount >= options.maxTerminalsPerProject) {
      return {
        success: false,
        error: `Maximum ${options.maxTerminalsPerProject} terminals per project`
      }
    }
  }

  // Check global terminal limit
  if (terminalStore.isTerminalLimitReached()) {
    return {
      success: false,
      error: `Maximum ${terminalStore.terminals.length} terminals allowed across all projects`
    }
  }

  // Resolve shell: explicit → project default → app default → undefined (backend picks)
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  const shell = options?.shell ?? project?.defaultShell ?? undefined

  try {
    // Ensure worktree symlinks are present when spawning into a worktree path
    if (project?.worktrees?.some((w) => w.path === cwd)) {
      await ensureWorktreeSymlinks(projectId)
    }

    // Resolve project env vars for spawn
    const { env, hasProjectEnv } = resolveEnvForSpawn(options?.envVars ?? project?.envVars, {})

    const spawnResult = await terminalApi.spawn({
      shell,
      cwd,
      projectId,
      ...(hasProjectEnv ? { env } : {})
    })

    if (!spawnResult.success) {
      return {
        success: false,
        error: spawnResult.error || 'Failed to create terminal'
      }
    }

    // Create terminal record in store
    const terminalCount = terminalStore.terminals.length
    const terminal = terminalStore.addTerminal(
      `Terminal ${terminalCount + 1}`,
      projectId,
      shell,
      cwd
    )

    // Link PTY ID to terminal record
    terminalStore.setTerminalPtyId(terminal.id, spawnResult.data.id)

    // CAP-3: store the issued lease credential on the terminal record
    // (in-memory only — never persisted).
    if (spawnResult.data.claim) {
      terminalStore.setTerminalClaim(spawnResult.data.id, spawnResult.data.claim)
    }

    // Add terminal tab to the workspace pane
    workspaceStore.addTabToPane(paneId, {
      type: 'terminal',
      id: `term-${terminal.id}`,
      terminalId: terminal.id
    })

    return {
      success: true,
      terminalId: terminal.id
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Outcome of {@link activateAndOpenTerminal}, so callers can phrase their own toast. */
export type ActivateAndOpenTerminalOutcome =
  | { status: 'opened'; terminalId?: string }
  | { status: 'no-pane' }
  | { status: 'spawn-failed'; error?: string }

/**
 * Activate a worktree (or the project root when `worktreeId` is null) and open a
 * terminal in `worktreePath`. The active-worktree sync is the only difference
 * from {@link openTerminalAtCwd}; the spawn + outcome mapping is shared there.
 * Used by the create-worktree flow (NewWorktreeModal). Callers own the toast
 * copy via the returned outcome.
 */
export async function activateAndOpenTerminal(
  projectId: string,
  worktreeId: string | null,
  worktreePath: string
): Promise<ActivateAndOpenTerminalOutcome> {
  useProjectStore.getState().setActiveWorktree(projectId, worktreeId)
  return openTerminalAtCwd(projectId, worktreePath)
}

/**
 * Open a terminal at an arbitrary `cwd` (e.g. a chat's worktree path) WITHOUT
 * the `setActiveWorktree` side effect that {@link activateAndOpenTerminal}
 * performs. Used by the project chat-row terminal icon, where the user's
 * "active worktree" must not change just because they spawned a terminal in a
 * chat's cwd. This is the shared spawn core: {@link activateAndOpenTerminal}
 * delegates here after syncing the worktree. Reuses {@link spawnTerminalInPane}
 * (which still wires worktree symlinks when `cwd` matches a stored worktree
 * path) and reads `activePaneId` + the per-project terminal limit from the
 * stores at call time. Durable failure logs go through `log-api.ts`
 * (`no-pane` warn, `spawn-failed` error); successful spawns are not logged
 * (the facade exposes no info level, and warn-on-success would be noise).
 */
export async function openTerminalAtCwd(
  projectId: string,
  cwd: string
): Promise<ActivateAndOpenTerminalOutcome> {
  const paneId = useWorkspaceStore.getState().activePaneId
  if (!paneId) {
    void logFrontendError({
      level: 'warn',
      source: 'terminal-spawn.openTerminalAtCwd',
      message: `No active pane; cannot open terminal (projectId=${projectId}, cwd=${cwd})`
    })
    return { status: 'no-pane' }
  }

  const maxTerminalsPerProject = useAppSettingsStore.getState().settings.maxTerminalsPerProject
  const result = await spawnTerminalInPane(paneId, projectId, cwd, {
    maxTerminalsPerProject
  })

  if (result.success) {
    return { status: 'opened', terminalId: result.terminalId }
  }
  void logFrontendError({
    level: 'error',
    source: 'terminal-spawn.openTerminalAtCwd',
    message: `Terminal spawn failed (projectId=${projectId}, cwd=${cwd}): ${result.error ?? 'unknown error'}`
  })
  return { status: 'spawn-failed', error: result.error }
}
