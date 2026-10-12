/**
 * Desktop ACP transport (Story 1.6): the Tauri `invoke`/`listen`
 * implementation of {@link AcpTransport}, including the `acp:events`
 * batch-frame fan-out registry.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import type { PersistedSessionSummary, WsAgentSummary } from '@shared/types/web-protocol.types'
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
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'
import { mapTauriVerdict } from './tauri-verdicts'
import {
  type AcpTransport,
  AcpTransportError,
  COMMAND_ACCEPTED_CODE,
  type CommandCallOptions
} from './types'

// --- Batched desktop events -------------------------------------------------
//
// The Rust `TauriEventSink` emits bursts as ONE `acp:events` frame carrying
// `{events:[{type:'acp:<name>', payload}]}`. One Tauri `listen` covers the
// whole stream; each inner event fans out to the listeners of its `acp:*`
// name, so subscribers keep the same `onEvent('acp:message_chunk', …)` API.

const TAURI_EVENTS_BATCH = 'acp:events'

interface TauriBatchInner {
  type?: string
  payload?: unknown
}

const tauriEventListeners = new Map<string, Set<(payload: unknown) => void>>()
let tauriListenersInstalled = false

function fanOutTauriEvent(name: string, payload: unknown): void {
  const set = tauriEventListeners.get(name)
  if (!set) return
  for (const cb of set) {
    try {
      cb(payload)
    } catch (err) {
      console.error('[acp-transport] listener error', err)
    }
  }
}

function installTauriEventListeners(): void {
  if (tauriListenersInstalled) return
  tauriListenersInstalled = true
  void listen<{ events?: TauriBatchInner[] }>(TAURI_EVENTS_BATCH, (event) => {
    const events = event.payload?.events
    if (!Array.isArray(events)) return
    for (const inner of events) {
      if (inner && typeof inner.type === 'string') {
        fanOutTauriEvent(inner.type, inner.payload)
      }
    }
  }).catch(console.error)
}

/** Test seam: clear the registry + install flag between tests so a mock
 * `listen` swap observes fresh installs and no callbacks leak across tests. */
export function _resetTauriEventRegistryForTests(): void {
  tauriEventListeners.clear()
  tauriListenersInstalled = false
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
    throw mapTauriVerdict(error)
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

export function createTauriAcpTransport(): AcpTransport {
  return {
    installRegistryBinary: (request) =>
      invoke<InstallAcpRegistryBinaryOutcome>('acp_install_registry_binary', { request }),
    // CAP-6 / Story 9: the host-owned verified-atomic install. The Tauri
    // adapter invokes the new `acp_install_agent` command (the host resolves
    // the agent by id from the catalog — no browser-supplied URLs/args). The
    // command returns `IpcResult<InstallOutcome>`; this adapter unwraps the
    // envelope so the launcher's `installedBinaryConfig(installed, ...)` gets
    // the bare `{ command, args }` (mirrors the web/WS transport). A failure
    // throws `AcpTransportError` carrying the install error code.
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
    probeRuntime: () => invoke<AcpRuntimeAvailability>('acp_probe_runtime'),
    setTurnTimeout: (secs) => invoke<void>('acp_set_turn_timeout', { secs }),
    setTurnIdleTimeout: (secs) => invoke<void>('acp_set_turn_idle_timeout', { secs }),
    setSessionNewTimeout: (secs) => invoke<void>('acp_set_session_new_timeout', { secs }),
    setSessionReopenTimeout: (secs) => invoke<void>('acp_set_session_reopen_timeout', { secs }),
    fetchRegistrySnapshot: (forceRefresh = false) =>
      invoke<AcpRegistrySnapshot>('acp_fetch_registry_snapshot', { forceRefresh }),
    probeMcpServer: (server) => invoke<ProbeResult>('acp_probe_mcp_server', { server }),
    spawnAgent: (config, options) =>
      invokeCommand<SpawnAgentResult>('acp_spawn_agent', { config }, options),
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
          ...(additionalDirectories?.length ? { additionalDirectories } : {})
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
          ...(additionalDirectories?.length ? { additionalDirectories } : {})
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
      // Listener registry: one Tauri `listen` per event name, fanning out to
      // all subscribers. Required for `acp:events` batches — the fan-out is
      // registry-keyed, so a per-call `listen` would never see inner events.
      installTauriEventListeners()
      let set = tauriEventListeners.get(eventName)
      if (!set) {
        set = new Set()
        tauriEventListeners.set(eventName, set)
        void listen<T>(eventName, (event) => {
          fanOutTauriEvent(eventName, event.payload)
        }).catch(console.error)
      }
      const cb = callback as (payload: unknown) => void
      set.add(cb)
      return () => {
        set.delete(cb)
        // Keep the entry even when empty: its native `listen` above is never
        // unhooked (one IPC hook per event name — a dead listen would unhook
        // every subscriber). Deleting it while the native listener stays armed
        // would let a later `onEvent` install a SECOND native listener, and
        // both would fan out each emitted event to the new subscriber.
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
