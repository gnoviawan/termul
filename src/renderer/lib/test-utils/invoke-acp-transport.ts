/**
 * Test double for the desktop ACP transport: maps every transport method to a
 * Tauri `invoke` named after the matching operation, so store/hook suites can
 * script the carrier boundary with a single `invoke` mock instead of a `/ws`
 * relay.
 *
 * It is NOT production code, and the `acp_*` names it invokes are only this
 * double's scripting vocabulary: the host registers no per-domain command for
 * them. The shipped desktop transport is `DesktopAcpTransport` (the `/ws`
 * protocol over `ChannelSocket`), covered by `acp-transport-carriers.test.ts`;
 * only the host-local commands (probes, timeouts, registry snapshot/binary
 * install) are real `invoke`s. `vitest.setup.ts` swaps the double in for
 * `DesktopAcpTransport`; suites that exercise the real class opt out with
 * `vi.unmock('@/lib/acp-transport/desktop-transport')`.
 */

import type { AcpCatalog } from '@shared/types/acp-catalog.types'
import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountUsage
} from '@shared/types/claude-accounts.types'
import type { IpcResult } from '@shared/types/ipc.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
import type { PersistedSessionSummary, WsAgentSummary } from '@shared/types/web-protocol.types'
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AcpRegistrySnapshot,
  AgentId,
  InstallAcpRegistryBinaryOutcome,
  ListSessionsResponse,
  NewSessionOutcome,
  ProbeResult,
  PromptDispatchResult,
  SessionConfigOption,
  SessionReopenOutcome,
  SpawnAgentResult
} from '@/lib/acp-api'
import {
  type AcpTransport,
  AcpTransportError,
  COMMAND_ACCEPTED_CODE,
  COMMAND_IN_PROGRESS_CODE,
  type CommandCallOptions
} from '@/lib/acp-transport/types'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'

// --- Ledger verdict strings -> typed errors ---------------------------------

const VERDICT_PREFIXES: ReadonlyArray<readonly [prefix: string, code: string]> = [
  ['outcome_unknown', WS_ERROR_CODES.OUTCOME_UNKNOWN],
  ['command_conflict', WS_ERROR_CODES.COMMAND_CONFLICT],
  ['command_in_progress', COMMAND_IN_PROGRESS_CODE],
  ['invalid_command_id', WS_ERROR_CODES.INVALID_COMMAND_ID],
  ['command_accepted', COMMAND_ACCEPTED_CODE],
  ['ACP_AGENT_UNAVAILABLE', WS_ERROR_CODES.AGENT_UNAVAILABLE],
  ['ACP_INVALID_AGENT_CONFIG', WS_ERROR_CODES.INVALID_AGENT_CONFIG]
]

function mapVerdict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (message === null) return error
  for (const [prefix, code] of VERDICT_PREFIXES) {
    if (message.startsWith(`${prefix}:`)) {
      const text = message.slice(prefix.length + 1).trim()
      return new AcpTransportError(code, text || code)
    }
  }
  return error
}

// ---------------------------------------------------------------------------
// Ledgered commands (AD-5)
// ---------------------------------------------------------------------------

/**
 * `invoke` a ledgered `acp_*` command: the client-minted `commandId` rides as
 * the optional camelCase argument, and the host's verdict error strings
 * (`outcome_unknown:`, `command_in_progress:`, ...) become typed
 * {@link AcpTransportError}s with the same codes the `/ws` carrier uses.
 */
async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown>,
  options?: CommandCallOptions
): Promise<T> {
  try {
    return await invoke<T>(
      command,
      options?.commandId ? { ...args, commandId: options.commandId } : args
    )
  } catch (error) {
    throw mapVerdict(error)
  }
}

/**
 * Like {@link invokeCommand} for commands with no result: a `command_accepted`
 * verdict (the command ran, its reply is not retained) IS the success.
 */
async function invokeCommandVoid(
  command: string,
  args: Record<string, unknown>,
  options?: CommandCallOptions
): Promise<void> {
  try {
    await invokeCommand<unknown>(command, args, options)
  } catch (error) {
    if (error instanceof AcpTransportError && error.code === COMMAND_ACCEPTED_CODE) return
    throw error
  }
}

// ---------------------------------------------------------------------------
// Tauri transport
// ---------------------------------------------------------------------------

export function createInvokeAcpTransport(): AcpTransport {
  return {
    installRegistryBinary: (request) =>
      invoke<InstallAcpRegistryBinaryOutcome>('acp_install_registry_binary', { request }),
    // The host-owned verified-atomic install. The scripted `invoke` returns
    // `IpcResult<InstallOutcome>`; this adapter unwraps the envelope so the
    // launcher's `installedBinaryConfig(installed, ...)` gets the bare
    // `{ command, args }` (as the real transport does). A failure throws
    // `AcpTransportError` carrying the install error code.
    installAcpAgent: async (agentId, options) => {
      const result = await invokeCommand<IpcResult<InstallAcpRegistryBinaryOutcome>>(
        'acp_install_agent',
        { request: { agentId } },
        options
      )
      if (result.success) {
        return result.data
      }
      throw new AcpTransportError(result.code, result.error)
    },
    // The registry commands share the `/ws` request names; a scripted invoke
    // answers them.
    addProject: (project) => invoke<ProjectSummary>('add_project', { ...project }),
    updateProject: (projectId, patch) => invoke<void>('update_project', { projectId, ...patch }),
    removeProject: (projectId, options) =>
      invoke<void>('remove_project', { projectId, ...options }),
    setDefaultProject: (projectId) => invoke<void>('set_default_project', { projectId }),
    listCatalog: async (refresh) => {
      const result = await invoke<IpcResult<AcpCatalog>>('acp_list_catalog', {
        refresh: refresh ?? false
      })
      if (result.success) return result.data
      throw new AcpTransportError(result.code, result.error)
    },
    setCatalogOptIn: async (enabled) => {
      const result = await invoke<IpcResult<void>>('acp_set_catalog_opt_in', { enabled })
      if (!result.success) throw new AcpTransportError(result.code, result.error)
    },
    probeRuntime: () => invoke<AcpRuntimeAvailability>('acp_probe_runtime'),
    setTurnTimeout: (secs) => invoke<void>('acp_set_turn_timeout', { secs }),
    setTurnIdleTimeout: (secs) => invoke<void>('acp_set_turn_idle_timeout', { secs }),
    setSessionNewTimeout: (secs) => invoke<void>('acp_set_session_new_timeout', { secs }),
    setSessionReopenTimeout: (secs) => invoke<void>('acp_set_session_reopen_timeout', { secs }),
    setAgentIdleWindow: (secs) => invoke<void>('acp_set_agent_idle_window', { secs }),
    getAgentIdleWindow: () =>
      invoke<{ secs: number; source: 'default' | 'setting' | 'env' | 'operator' }>(
        'acp_get_agent_idle_window'
      ),
    fetchRegistrySnapshot: (forceRefresh = false) =>
      invoke<AcpRegistrySnapshot>('acp_fetch_registry_snapshot', { forceRefresh }),
    probeMcpServer: (server) => invoke<ProbeResult>('acp_probe_mcp_server', { server }),
    listClaudeAccounts: () => invoke<ClaudeAccountsSnapshot>('claude_accounts_list'),
    listClaudeUsage: (force = false) =>
      invoke<ClaudeAccountUsage[]>('claude_accounts_usage', { force }),
    setDefaultClaudeAccount: async (accountId) => {
      await invoke('claude_accounts_set_default', { accountId })
    },
    setProjectClaudeAccount: async (projectId, accountId) => {
      await invoke('claude_accounts_set_project', { projectId, accountId })
    },
    spawnAgent: (config, options, projectId) =>
      invokeCommand<SpawnAgentResult>(
        'acp_spawn_agent',
        { config, projectId: projectId ?? null },
        options
      ),
    killAgent: async (agentId) => {
      await invoke('acp_kill_agent', { agentId })
    },
    listAgents: () => invoke<AgentId[]>('acp_list_agents'),
    // CAP-11: identity-rich summaries (parity with the WS `list_agents`
    // reply); `listAgents` above keeps returning bare ids.
    listAgentDetails: () => invoke<WsAgentSummary[]>('acp_list_agent_details'),
    newSession: (agentId, cwd, mcpServers, options) =>
      invokeCommand<NewSessionOutcome>(
        'acp_new_session',
        {
          agentId,
          cwd,
          mcpServers,
          ...(options?.ephemeral ? { ephemeral: true } : {}),
          ...(options?.promotable ? { promotable: true } : {}),
          ...(options?.projectId ? { projectId: options.projectId } : {}),
          ...(options?.worktreePath ? { worktreePath: options.worktreePath } : {}),
          ...(options?.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {}),
          ...(options?.additionalDirectories?.length
            ? { additionalDirectories: options.additionalDirectories }
            : {})
        },
        options
      ),
    loadSession: (agentId, sessionId, cwd, additionalDirectories, options) =>
      invokeCommand<SessionReopenOutcome>(
        'acp_load_session',
        {
          agentId,
          sessionId,
          cwd,
          ...(additionalDirectories?.length ? { additionalDirectories } : {}),
          ...(options?.mcpServers ? { mcpServers: options.mcpServers } : {})
        },
        options
      ),
    resumeSession: (agentId, sessionId, cwd, additionalDirectories, options) =>
      invokeCommand<SessionReopenOutcome>(
        'acp_resume_session',
        {
          agentId,
          sessionId,
          cwd,
          ...(additionalDirectories?.length ? { additionalDirectories } : {}),
          ...(options?.mcpServers ? { mcpServers: options.mcpServers } : {})
        },
        options
      ),
    deleteAgentSession: (agentId, sessionId, options) =>
      invokeCommandVoid('acp_delete_agent_session', { agentId, sessionId }, options),
    logout: (agentId, options) => invokeCommandVoid('acp_logout', { agentId }, options),
    respondElicitation: (agentId, requestId, action, content, options) =>
      invokeCommandVoid(
        'acp_respond_elicitation',
        { agentId, requestId, action, content },
        options
      ),
    closeSession: (agentId, sessionId, options) =>
      invokeCommandVoid('acp_close_session', { agentId, sessionId }, options),
    disposeEphemeralSession: (agentId, sessionId, options) =>
      invokeCommandVoid('acp_dispose_ephemeral_session', { agentId, sessionId }, options),
    promoteSession: (agentId, sessionId, options) =>
      invokeCommandVoid('acp_promote_session', { agentId, sessionId }, options),
    // CAP-2: durable agent-switch marker — desktop parity with the WS
    // `record_agent_switch` route. The command validates + persists ONE
    // durable record then fans the synthetic event through its sinks.
    recordAgentSwitch: (sessionId, record, options) =>
      invokeCommandVoid(
        'acp_record_agent_switch',
        {
          sessionId,
          fromConfigId: record.fromConfigId,
          toConfigId: record.toConfigId,
          newSessionId: record.newSessionId,
          summaryText: record.summaryText
        },
        options
      ),
    listSessions: (agentId, cwd, cursor) =>
      invoke<ListSessionsResponse>('acp_list_sessions', { agentId, cwd, cursor }),
    registerDiscoveredSession: (input, options) =>
      invokeCommand<PersistedSessionSummary>('acp_register_discovered_session', input, options),
    sendPrompt: (agentId, sessionId, text, turnId, displayContent) =>
      invoke<PromptDispatchResult>('acp_send_prompt', {
        agentId,
        sessionId,
        text,
        turnId,
        displayContent
      }),
    sendPromptBlocks: (agentId, sessionId, content, turnId, displayContent) =>
      invoke<PromptDispatchResult>('acp_send_prompt', {
        agentId,
        sessionId,
        content,
        turnId,
        displayContent
      }),
    cancelPrompt: async (agentId, sessionId) => {
      await invoke('acp_cancel_prompt', { agentId, sessionId })
    },
    setConfigOption: (agentId, sessionId, configId, valueId) =>
      invoke<SessionConfigOption[] | null>('acp_set_config_option', {
        agentId,
        sessionId,
        configId,
        valueId
      }),
    setMode: async (agentId, sessionId, modeId) => {
      await invoke('acp_set_mode', { agentId, sessionId, modeId })
    },
    setModel: async (agentId, sessionId, modelId) => {
      await invoke('acp_set_model', { agentId, sessionId, modelId })
    },
    // No `commandId`: the desktop commands for permission/question answers do not
    // accept one (the facade claims no id for them on desktop).
    respondPermission: async (agentId, requestId, optionId) => {
      await invoke('acp_respond_permission', { agentId, requestId, optionId })
    },
    answerQuestion: async (agentId, questionId, values) => {
      await invoke('acp_answer_question', { agentId, questionId, values })
    },
    authenticate: (agentId, methodId, gateway, options) =>
      invokeCommandVoid('acp_authenticate', { agentId, methodId, gateway }, options),
    deliverAuthRedirect: (agentId, url, options) =>
      invokeCommand<number>('acp_auth_deliver_redirect', { agentId, url }, options),
    onEvent<T>(eventName: string, callback: (payload: T, eventSeq?: number) => void): () => void {
      let detached = false
      let unlisten: (() => void) | null = null
      void Promise.resolve(listen<T>(eventName, (event) => callback(event.payload)))
        .then((fn) => {
          if (detached) fn?.()
          else unlisten = fn ?? null
        })
        .catch(console.error)
      return () => {
        detached = true
        unlisten?.()
      }
    },
    connect: async () => {
      /* desktop uses Tauri IPC — no socket */
    },
    dispose: () => {
      /* no-op */
    }
  }
}
