import { terminalApi } from '@/lib/terminal-api'
import { randomUUID } from '@/lib/uuid'
import { GLOBAL_TERMINAL_LIMIT, useTerminalStore } from '@/stores/terminal-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * Spawn the agent's login terminal for a `type:'terminal'` auth method
 * (spec-acp-terminal-auth): the agent binary + the method's args/env in the
 * session cwd as a `kind:'shell'` tab named `Sign in — <agent>`. The login
 * terminal is an ordinary extra tab — never killed or recreated. Mirrors the
 * batched terminal-store write of `launchAgentInPane` (single set() so
 * syncTerminalTabs never sees a half-built record).
 */
export async function spawnAcpLoginTerminal(opts: {
  paneId: string
  projectId: string
  cwd: string
  program: string
  args: string[]
  env?: Record<string, string>
  tabName: string
}): Promise<{ success: boolean; ptyId?: string; error?: string }> {
  const terminalStore = useTerminalStore.getState()
  const workspaceStore = useWorkspaceStore.getState()

  if (terminalStore.isTerminalLimitReached()) {
    return {
      success: false,
      error: `Maximum ${GLOBAL_TERMINAL_LIMIT} terminals allowed across all projects`
    }
  }

  try {
    const spawnResult = await terminalApi.spawn({
      projectId: opts.projectId,
      cwd: opts.cwd,
      program: opts.program,
      args: opts.args,
      kind: 'shell',
      ...(opts.env !== undefined ? { env: opts.env } : {})
    })
    if (!spawnResult.success) {
      return {
        success: false,
        error: spawnResult.error || 'Failed to open the sign-in terminal'
      }
    }

    // The pane may have closed while the spawn was in flight — a tab added to
    // a dead pane leaves an orphaned PTY. Kill it and report failure.
    if (!findPaneById(useWorkspaceStore.getState().root, opts.paneId)) {
      void terminalApi.kill(spawnResult.data.id)
      return {
        success: false,
        error: 'The pane closed before the sign-in terminal could attach.'
      }
    }

    const terminalId = randomUUID()
    const latestTerminals = useTerminalStore.getState().terminals
    terminalStore.setTerminals([
      ...latestTerminals,
      {
        id: terminalId,
        name: opts.tabName,
        projectId: opts.projectId,
        shell: opts.program,
        cwd: opts.cwd,
        output: [],
        healthStatus: 'running',
        isHidden: false,
        ptyId: spawnResult.data.id,
        kind: 'shell',
        ...(spawnResult.data.claim ? { claim: spawnResult.data.claim } : {})
      }
    ])
    terminalStore.selectTerminal(terminalId)
    workspaceStore.addTabToPane(opts.paneId, {
      type: 'terminal',
      id: `term-${terminalId}`,
      terminalId
    })
    return { success: true, ptyId: spawnResult.data.id }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
