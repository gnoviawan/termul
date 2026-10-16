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
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export interface SpawnTerminalOptions {
  /** Shell path/name. If omitted, resolves from project default → app default. */
  shell?: string
  /** Project environment variables for spawn. */
  envVars?: Array<{ key: string; value: string; enabled?: boolean }>
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

/** Outcome of {@link openTerminalAtCwd}, so callers can phrase their own toast. */
export type OpenTerminalOutcome =
  | { status: 'opened'; terminalId?: string }
  | { status: 'no-pane' }
  | { status: 'spawn-failed'; error?: string }

/**
 * Open a terminal at an arbitrary `cwd` (e.g. a chat's or a new worktree's
 * path). It never changes the Workspace-switcher pick: spawning a terminal in
 * a worktree must not move the user's active worktree. Used by the project
 * chat-row terminal icon and the create-worktree flow. Reuses {@link spawnTerminalInPane}
 * (which still wires worktree symlinks when `cwd` matches a stored worktree
 * path) and reads `activePaneId` from the store at call time. Durable failure logs go through `log-api.ts`
 * (`no-pane` warn, `spawn-failed` error); successful spawns are not logged
 * (the facade exposes no info level, and warn-on-success would be noise).
 */
export async function openTerminalAtCwd(
  projectId: string,
  cwd: string
): Promise<OpenTerminalOutcome> {
  const paneId = useWorkspaceStore.getState().activePaneId
  if (!paneId) {
    void logFrontendError({
      level: 'warn',
      source: 'terminal-spawn.openTerminalAtCwd',
      message: `No active pane; cannot open terminal (projectId=${projectId}, cwd=${cwd})`
    })
    return { status: 'no-pane' }
  }

  const result = await spawnTerminalInPane(paneId, projectId, cwd)

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
