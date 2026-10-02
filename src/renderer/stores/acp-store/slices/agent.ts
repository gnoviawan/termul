/**
 * Agent slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { type AgentId, type AuthMethod, acpApi, type SessionId } from '@/lib/acp-api'
import { saveAuthMethodMemory as saveAuthMethodMemoryToDisk } from '@/lib/acp-auth-method-memory'
import { AmbiguousAuthError, isAmbiguousAuthError } from '@/lib/agents/acp-spawn-errors'
import { factoryKeyApi } from '@/lib/factory-key-api'
import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import { isDetachedReuseKey, parseReuseKey } from '../../acp-reuse-keys'
import {
  authPickerUnavailableError,
  configIdForAgentId,
  dropPermissionsForAgent,
  dropPreparedSlots,
  dropQuestionsForAgent,
  finalizeStreaming,
  inFlightAuthKey,
  isAuthRetriableSessionError,
  liveInlineKeyAuthPolicy
} from '../helpers'
import { useAcpStore } from '../index'
import {
  commitMessageCollectors,
  ephemeralSessionIds,
  persistSession,
  rejectCommitMessageCollector,
  rejectTerminalAssistCollector,
  terminalAssistCollectors
} from '../shared-state'
import type { AcpState, AgentStatus, SessionStatus } from '../types'
import { dropSessionTranscriptState, flushCoalescedSync } from './transcript'

/**
 * Agents that have completed ACP `authenticate` in this process lifetime, so
 * `createSession` does not re-authenticate a reused agent on every session. An
 * auth-category `session/new` failure clears the agent from this set (see
 * `createSession`) so a manual Sign-in + retry can re-authenticate. Held outside
 * reactive state (identity set, not UI data).
 */
export const authenticatedAgents = new Set<AgentId>()

/**
 * In-flight `authenticate` promises keyed by `${agentId}\0${methodId}` so
 * concurrent calls share a single authenticate round-trip instead of racing
 * duplicate requests. The method id is part of the key: an explicit Sign-in
 * click for method B must NOT resolve onto an in-flight auto-authenticate for
 * remembered method A — different methods are different requests; only
 * same-method concurrency dedupes. The promise resolves `true` once the
 * `authenticate` request succeeded (a caller that shares it can rely on the
 * agent being authenticated).
 */
const inFlightAuth = new Map<string, Promise<boolean>>()

/** Drop every in-flight authenticate for a torn-down agent (any method). */
function dropInFlightAuthForAgent(agentId: AgentId): void {
  for (const key of inFlightAuth.keys()) {
    if (key.startsWith(`${agentId}\0`)) inFlightAuth.delete(key)
  }
}

/**
 * Remembered auth method per configured agent (spec-acp-persistent-auth-reuse):
 * `configId` → the `AuthMethod.id` that last completed `authenticate` for that
 * config. Loaded once with `loadAgentConfigs` and persisted under the
 * `acp/auth-methods` persistenceApi key via `saveAuthMethodMemoryToDisk`.
 * Only the method id is held — never credentials. The memory authorizes
 * auto-authenticate for a MULTI-method agent (which otherwise must never pick
 * silently); it is cleared when the remembered id stops being advertised or
 * its authenticate fails.
 */
export const rememberedAuthMethods = new Map<string, string>()

/**
 * Config ids whose remembered method was explicitly forgotten this session.
 * Guards the `loadAgentConfigs` disk-merge so a stale persisted entry cannot
 * resurrect in memory when the reload runs before the forget's queued write
 * has landed on disk. Cleared when the config is remembered again.
 */
export const forgottenAuthMethodConfigs = new Set<string>()

/**
 * The method id of the most recent `acpApi.authenticate` dispatch per agent
 * (spec-acp-persistent-auth-reuse). `completeBrowserAuth` marks an agent
 * authenticated WITHOUT an `authenticate` response — the OAuth redirect
 * completes out-of-band — so it reads + consumes this to persist the winning
 * method id. Set right before every authenticate dispatch; deleted on read
 * and on agent teardown.
 */
const lastAuthAttempt = new Map<AgentId, string>()

/**
 * Serializes `acp/auth-methods` writes so a rapid remember→forget ordering is
 * preserved on disk — each queued write persists the snapshot taken at enqueue
 * time, so the LAST mutation always wins even if earlier writes are slow.
 */
let authMethodMemoryWriteChain: Promise<void> = Promise.resolve()

function persistAuthMethodMemory(): void {
  const snapshot = Object.fromEntries(rememberedAuthMethods)
  authMethodMemoryWriteChain = authMethodMemoryWriteChain
    .then(() => saveAuthMethodMemoryToDisk(snapshot))
    .catch((err: unknown) => {
      // Best-effort: a failed write only means the next process falls back to
      // the picker — log without blocking the session flow.
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.authMethodMemory',
        message: `Failed to persist remembered auth methods: ${String(err)}`
      })
    })
}

function rememberAuthMethodForConfig(configId: string, methodId: string): void {
  forgottenAuthMethodConfigs.delete(configId)
  if (rememberedAuthMethods.get(configId) === methodId) return
  rememberedAuthMethods.set(configId, methodId)
  persistAuthMethodMemory()
}

export function forgetAuthMethodForConfig(configId: string): void {
  // Tombstone even when nothing was remembered: the init merge must never
  // resurrect a stale disk entry for a config whose memory was just cleared.
  forgottenAuthMethodConfigs.add(configId)
  if (!rememberedAuthMethods.delete(configId)) return
  persistAuthMethodMemory()
}

/**
 * Validated `browser_open_request` URLs received BEFORE the agent registers
 * (`ShimWatcher` starts before `agent_spawned` reaches the renderer — an
 * early browser call would otherwise be dropped and the OAuth URL lost).
 * Promoted into `pendingBrowserOpen` by `_onAgentSpawned`; cleared on
 * teardown via `clearPendingBrowserOpen`.
 */
const earlyBrowserOpen = new Map<AgentId, string>()

/** Test-only: reset authenticate dedupe + authenticated-agent tracking. */
export function _resetAcpAuthForTesting(): void {
  authenticatedAgents.clear()
  inFlightAuth.clear()
  earlyBrowserOpen.clear()
  rememberedAuthMethods.clear()
  forgottenAuthMethodConfigs.clear()
  lastAuthAttempt.clear()
  // Drop a queued memory write so it cannot leak into the next test.
  authMethodMemoryWriteChain = Promise.resolve()
}

/**
 * Run ACP `authenticate` on demand after a session call reported auth-required
 * (spec-acp-persistent-auth-reuse — no longer called preemptively; see
 * `withAuthRetry`). The spawn response populates `authMethods` synchronously
 * (CAP-4: the response — not the async `acp:agent_spawned` event — is the
 * source of truth), so this reads them directly with no timed fallback:
 *   - `hostAuthReady` (managed auth prepared on the host) → resolve `false`,
 *   - no valid method → resolve `false` (nothing was authenticated; the caller
 *     must NOT retry — a second call would fail identically),
 *   - an advertised `inlineKeyFormMethodId` with a stored host key (S2-TS,
 *     e.g. Factory Droid) → `authenticate` with that method,
 *   - `reusePersistedCredentials` policy with multiple methods → resolve
 *     `false` (the session call already exercised the persisted CLI
 *     credentials — AuthRequired surfaces the sign-in banner),
 *   - exactly one valid method → `authenticate(methodId)`,
 *   - more than one → `authenticate` ONLY with the persisted previously-
 *     successful method for this config when it is still advertised and
 *     agent-runnable; otherwise reject with {@link AmbiguousAuthError}
 *     (never silently choose a method — the picker stays the fallback).
 *
 * A method whose id is empty/whitespace is ignored (P5). Resolves `true` only
 * when an `authenticate` was actually dispatched and succeeded. Concurrent
 * calls for the same agent+method share one in-flight authenticate (P2); the
 * method id is resolved BEFORE the dedup lookup so an explicit click for a
 * different method never resolves onto this request. On success the agent is
 * remembered so a reused agent is not re-authenticated, and the method id is
 * persisted per configId so future processes can auto-authenticate.
 */
async function authenticateBeforeSession(get: () => AcpState, agentId: AgentId): Promise<boolean> {
  if (authenticatedAgents.has(agentId)) return false

  // Managed Claude auth was validated and prepared on the host before spawn.
  // ACP's advertised alternatives are not additional login steps in this
  // mode; skip only when the host explicitly confirms readiness.
  if (get().agents[agentId]?.hostAuthReady === true) return false

  // Resolve the target method BEFORE the dedup lookup — the key embeds it.
  // Selection throws synchronously for the multi-auth/no-memory paths, which
  // is safe: nothing has been stored in `inFlightAuth` yet, so no settled
  // rejection can wedge the map (the QA F6 wedge required a stored promise).
  const methods = get().agents[agentId]?.authMethods ?? []
  // P5: ignore empty/whitespace ids — an unusable method must not be sent.
  const valid = methods.filter((m) => typeof m.id === 'string' && m.id.trim().length > 0)
  if (valid.length === 0) return false
  const configId = configIdForAgentId(get(), agentId)

  let method: AuthMethod | undefined
  let remembered = false
  let inlineKeyFlow = false

  // S2-TS policy: an agent whose auth policy carries an
  // `inlineKeyFormMethodId` (e.g. Factory Droid's "Factory API Key") keeps
  // the key on the host — authenticate with it on demand when the host has a
  // stored key; with no stored key, fall through to normal resolution so the
  // picker still offers the explicit sign-in paths.
  const authPolicy = liveInlineKeyAuthPolicy(get, agentId)
  const inlineKeyMethodId = authPolicy?.inlineKeyFormMethodId
  if (inlineKeyMethodId != null) {
    const keyMethod = valid.find((m) => m.id === inlineKeyMethodId)
    if (keyMethod) {
      let hasKey = false
      try {
        hasKey = await factoryKeyApi.status()
      } catch {
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.authenticateBeforeSession',
          message: 'Factory credential status could not be read'
        })
      }
      if (hasKey) {
        method = keyMethod
        inlineKeyFlow = true
      }
    }
  }

  if (!method && authPolicy?.reusePersistedCredentials === true && valid.length > 1) {
    // Droid advertises login methods even after a prior browser login has
    // persisted in the CLI. The session call already exercised those
    // credentials and reported auth-required — report no-auth so the caller
    // surfaces the sign-in banner instead of picking a method silently.
    void logFrontendError({
      level: 'info',
      source: 'acp-store.authenticateBeforeSession',
      message: 'Persisted-credentials policy: leaving sign-in to the banner'
    })
    return false
  }

  if (!method) {
    if (valid.length === 1) {
      method = valid[0]
      // Stale cleanup beyond the multi-method branch: a remembered id that no
      // longer matches the sole advertised method can never win again — drop it.
      const rememberedId = configId ? rememberedAuthMethods.get(configId) : undefined
      if (rememberedId && configId && rememberedId !== method.id.trim()) {
        forgetAuthMethodForConfig(configId)
      }
    } else {
      // Multi-method: the ONLY silent pick allowed is the method id the user
      // previously succeeded with on this config (persisted memory). A
      // remembered id that is no longer advertised is stale — drop it before
      // surfacing the picker.
      const rememberedId = configId ? rememberedAuthMethods.get(configId) : undefined
      const hit = rememberedId ? valid.find((m) => m.id.trim() === rememberedId) : undefined
      if (!hit) {
        if (rememberedId && configId) forgetAuthMethodForConfig(configId)
        throw new AmbiguousAuthError(valid)
      }
      // Terminal/env_var methods NEVER auto-run (spec-acp-terminal-auth):
      // terminal requires an explicit click that spawns a login terminal tab;
      // env_var is unsupported (respawn-with-env out of scope). A remembered id
      // that resolves to a non-agent type is a dead entry — forget it, then
      // fall back to the picker (terminal auth is interactive).
      if (hit.type !== 'agent' && hit.type != null) {
        if (configId) forgetAuthMethodForConfig(configId)
        throw new AmbiguousAuthError(valid)
      }
      method = hit
      remembered = true
      // Boundary log: the method id is advertised metadata — the backend itself
      // logs `authenticating via '{id}'` — never a credential.
      void logFrontendError({
        level: 'info',
        source: 'acp-store.authenticateBeforeSession',
        message: `Auto-authenticating with the remembered sign-in method '${method.id.trim()}'`
      })
    }
  }
  // A single non-agent method cannot be driven automatically — resolve false
  // so the caller skips the guaranteed-duplicate retry (the auth banner offers
  // the explicit sign-in paths). A missing `type` (older host) is treated as
  // 'agent' — the pre-extension wire only ever carried agent methods.
  if (method.type !== 'agent' && method.type != null) return Promise.resolve(false)

  const methodId = method.id.trim()
  const flightKey = inFlightAuthKey(agentId, methodId)
  const existing = inFlightAuth.get(flightKey)
  if (existing) return existing

  const task = (async (): Promise<boolean> => {
    try {
      // Record the attempted method so `completeBrowserAuth` (the OAuth
      // redirect lands out-of-band without an authenticate reply) can persist
      // the winning method id per config.
      lastAuthAttempt.set(agentId, methodId)
      await acpApi.authenticate(agentId, methodId)
    } catch (err) {
      // Redacted boundary log: an agent's auth failure may echo credentials
      // or method details, so record only that the request failed — never the
      // method id or the raw error text. The error is rethrown unchanged for
      // the caller to classify and surface.
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.authenticateBeforeSession',
        message: 'Agent authenticate request failed before session creation'
      })
      // S2-TS: the stored host key failed — surface the actionable message
      // (the raw agent error is redacted and may echo credentials).
      if (inlineKeyFlow) {
        throw new Error('Factory API key authentication failed. Enter a new key or choose Login.')
      }
      // A failed REMEMBERED method is a dead end — forget it and fall back to
      // the picker instead of surfacing a bare auth error. Only when the
      // failure is auth-classified: a transport drop or timeout must not wipe
      // a still-valid remembered method, and masking it as AmbiguousAuthError
      // would classify as multi-auth — skipping transport eviction of a dead
      // process. Non-auth failures propagate unchanged.
      if (remembered && isAuthRetriableSessionError(err)) {
        if (configId) forgetAuthMethodForConfig(configId)
        throw new AmbiguousAuthError(valid)
      }
      throw err
    }
    authenticatedAgents.add(agentId)
    // Persist the winning method id so the next process for this config can
    // auto-authenticate on demand (never a credential — just the id). Method
    // selection above already guarantees agent/untyped eligibility.
    if (configId) rememberAuthMethodForConfig(configId, methodId)
    // Auth succeeded — a pending browser-open request for this agent is
    // resolved; drop it so the dialog dismisses. Module-scope helper: the
    // store exists by the time any auth flow runs.
    useAcpStore.getState().clearPendingBrowserOpen(agentId)
    return true
  })()
  inFlightAuth.set(flightKey, task)
  // The cleanup is a `then` callback (never an in-body `finally`): a `then`
  // runs as a microtask — after the `set` above — and the identity guard
  // keeps a late cleanup from deleting a newer in-flight entry for the same
  // agent+method (e.g. after a mid-flight disconnect cleared the map).
  const cleanup = () => {
    if (inFlightAuth.get(flightKey) === task) inFlightAuth.delete(flightKey)
  }
  task.then(cleanup, cleanup)
  return task
}

/**
 * Authenticate-on-demand wrapper for agent session calls (`session/new`,
 * `session/load`, `session/resume`) — spec-acp-persistent-auth-reuse. The call
 * runs FIRST with no preemptive auth: a globally logged-in agent (or a reused
 * process) goes straight through. Only when the call reports an auth failure
 * ({@link isAuthRetriableSessionError}) does it run
 * `authenticateBeforeSession` — auto for a single unambiguous method or the
 * persisted previously-successful one, else the AmbiguousAuthError picker
 * path — then retries the call ONCE. A stale `authenticatedAgents` flag is
 * purged first so a mid-process expiry actually re-authenticates. When
 * nothing was authenticated (no valid / only non-agent methods) the original
 * error propagates without a guaranteed-duplicate retry; a second auth
 * failure after a successful authenticate forgets the remembered method and
 * propagates so the caller's existing error surface handles it.
 *
 * `surface` is how auth failures are presented: 'picker' (session/new — the
 * launcher renders the method picker for AmbiguousAuthError) or 'text'
 * (history reopen / resume — text-only `lastError` + Retry, where the
 * ambiguous-methods error is translated into actionable guidance).
 * `op` is a static label for the redacted boundary logs — never raw errors or
 * method payloads.
 */
export async function withAuthRetry<T>(
  get: () => AcpState,
  agentId: AgentId,
  op: 'session/new' | 'session/load' | 'session/resume',
  surface: 'picker' | 'text',
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (firstErr) {
    if (!isAuthRetriableSessionError(firstErr)) throw firstErr
    void logFrontendError({
      level: 'info',
      source: 'acp-store.withAuthRetry',
      message: `${op} reported auth required; authenticating on demand`
    })
    // The failed call just proved the process is NOT authenticated — a stale
    // `authenticatedAgents` flag (e.g. a token that expired server-side
    // mid-process) must not make authenticateBeforeSession early-return.
    authenticatedAgents.delete(agentId)
    let didAuthenticate: boolean
    try {
      didAuthenticate = await authenticateBeforeSession(get, agentId)
    } catch (err) {
      // A text-only surface has no method picker — translate the "pick one of
      // the methods below" error into guidance the user can act on there.
      throw surface === 'text' && isAmbiguousAuthError(err) ? authPickerUnavailableError() : err
    }
    // Nothing was sent (zero valid methods / only non-agent methods): the
    // retry would fail identically — surface the ORIGINAL error instead.
    if (!didAuthenticate) throw firstErr
    try {
      const outcome = await fn()
      void logFrontendError({
        level: 'info',
        source: 'acp-store.withAuthRetry',
        message: `${op} succeeded after authenticate-on-demand`
      })
      return outcome
    } catch (retryErr) {
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.withAuthRetry',
        message: `${op} failed again after the authenticate-on-demand retry`
      })
      // A method that authenticates but still cannot authorize the session is
      // a dead remembered pick — forget it so the next failure shows the
      // picker instead of looping the same silent choice.
      if (isAuthRetriableSessionError(retryErr)) {
        const configId = configIdForAgentId(get(), agentId)
        if (configId) forgetAuthMethodForConfig(configId)
      }
      throw retryErr
    }
  }
}

/**
 * Evict a live agent after a transport/connection failure (P3/P8): a destroyed
 * stream or refused connection means the process cannot be reused, so it is
 * killed and dropped from reuse state before any retry (a fresh spawn follows).
 * A failed kill is logged and swallowed — the agent is being discarded anyway.
 */
export async function evictAgentForTransport(get: () => AcpState, agentId: AgentId): Promise<void> {
  // Drop auth tracking BEFORE the kill so a failed kill still leaves no stale
  // auth state for the (about to be re-spawned) process slot.
  authenticatedAgents.delete(agentId)
  dropInFlightAuthForAgent(agentId)
  lastAuthAttempt.delete(agentId)
  try {
    await get().killAgent(agentId)
  } catch (err) {
    // P8: surface the kill failure without letting it mask the setup error.
    console.warn('[acp] failed to kill agent during transport eviction', agentId, err)
  }
}

type AgentSliceState = Pick<
  AcpState,
  | 'agents'
  | 'agentStatus'
  | 'pendingBrowserOpen'
  | 'pendingRestartVersions'
  | 'spawnAgent'
  | 'killAgent'
  | 'clearPendingBrowserOpen'
  | 'completeBrowserAuth'
  | 'authenticateAgent'
  | '_onAgentSpawned'
  | '_onAgentError'
  | '_onAgentCrashed'
  | '_onAgentDisconnected'
  | '_onBrowserOpenRequest'
>

export const createAgentSlice: StateCreator<AcpState, [], [], AgentSliceState> = (set, get) => ({
  agents: {},
  agentStatus: {},
  pendingBrowserOpen: {},

  pendingRestartVersions: {},

  spawnAgent: async (config) => {
    const tempKey = config.name
    set((s) => ({ agentStatus: { ...s.agentStatus, [tempKey]: 'spawning' } }))
    try {
      const result = await acpApi.spawnAgent(config)
      const agentId = result.agentId
      set((s) => {
        // Drop the transient name-keyed `spawning` marker now that we have the
        // real agent id; leaving it would strand a stale status forever.
        const agentStatus = { ...s.agentStatus }
        delete agentStatus[tempKey]
        agentStatus[agentId] = 'connected'
        // The spawn response is the authoritative source of capabilities +
        // authMethods (CAP-4: metadata delivery cannot depend on a session
        // subscription that does not yet exist). The `acp:agent_spawned` event
        // MAY have pre-seeded this entry (it can fire before the response
        // resolves on desktop), but it is observer-only and may omit fields
        // (e.g. `authMethods ?? []` seeds an empty array, which is not nullish
        // and would otherwise shadow the response's real methods). So prefer
        // the RESPONSE first and use the event-seeded entry only as a fallback.
        // The response and event carry identical data in the common case, so
        // this precedence is safe.
        const existing = s.agents[agentId]
        return {
          agents: {
            ...s.agents,
            [agentId]: {
              id: agentId,
              capabilities: result.capabilities ?? existing?.capabilities,
              authMethods: result.authMethods ?? existing?.authMethods ?? [],
              hostAuthReady: result.hostAuthReady ?? existing?.hostAuthReady ?? false
            }
          },
          agentStatus
        }
      })
      return agentId
    } catch (err) {
      set((s) => ({ agentStatus: { ...s.agentStatus, [tempKey]: 'error' } }))
      throw err
    }
  },

  killAgent: async (agentId) => {
    await acpApi.killAgent(agentId)
    // Drop cached auth for the torn-down process so a re-spawn re-authenticates
    // (the new subprocess has unknown auth state; a stale `authenticatedAgents`
    // entry would make `authenticateBeforeSession` skip `authenticate`).
    authenticatedAgents.delete(agentId)
    dropInFlightAuthForAgent(agentId)
    lastAuthAttempt.delete(agentId)
    set((s) => {
      const agents = { ...s.agents }
      const agentStatus = { ...s.agentStatus }
      delete agents[agentId]
      delete agentStatus[agentId]
      // Drop any config->live mapping pointing at this agent so it can't be
      // reused after the process is gone.
      const configToLiveAgent = { ...s.configToLiveAgent }
      for (const cid of Object.keys(configToLiveAgent)) {
        if (configToLiveAgent[cid] === agentId) delete configToLiveAgent[cid]
      }
      // mark this agent's sessions closed
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === agentId) {
          sessions[id] = {
            ...sessions[id],
            status: 'closed',
            activeTurn: false,
            openTurnId: null,
            replaying: null
          }
        }
      }
      return {
        agents,
        agentStatus,
        configToLiveAgent,
        sessions,
        // An intentional kill emits no lifecycle events (L4), so no event
        // handler will retire this agent's warm-pool slots — drop them here.
        preparedSessions: dropPreparedSlots(
          s.preparedSessions,
          (sid) => s.sessions[sid]?.agentId === agentId
        ),
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, agentId),
        pendingQuestions: dropQuestionsForAgent(s.pendingQuestions, agentId)
      }
    })
    // A killed agent can never finish its browser-open flow — drop the
    // captured URL so the dialog dismisses.
    get().clearPendingBrowserOpen(agentId)
  },

  clearPendingBrowserOpen: (agentId) => {
    earlyBrowserOpen.delete(agentId)
    set((s) => {
      if (!(agentId in s.pendingBrowserOpen)) return {}
      const pendingBrowserOpen = { ...s.pendingBrowserOpen }
      delete pendingBrowserOpen[agentId]
      return { pendingBrowserOpen }
    })
  },

  completeBrowserAuth: (agentId) => {
    // A delivered redirect means the agent's listener accepted the OAuth
    // callback — the flow completed without an `authenticate` round-trip.
    authenticatedAgents.add(agentId)
    // Browser auth never sees an `authenticate` response, so persist the
    // attempted method id here — only when it can auto-run again
    // (agent/untyped), the same rule as the explicit Sign-in path. The entry
    // is consumed on read.
    const attempted = lastAuthAttempt.get(agentId)
    lastAuthAttempt.delete(agentId)
    if (attempted) {
      const configId = configIdForAgentId(get(), agentId)
      const method = (get().agents[agentId]?.authMethods ?? []).find(
        (m) => m.id.trim() === attempted
      )
      if (configId && (method?.type === 'agent' || method?.type == null)) {
        rememberAuthMethodForConfig(configId, attempted)
      }
    }
    get().clearPendingBrowserOpen(agentId)
    // Re-prepare chats that failed on auth so their banners clear on their
    // own. `configToLiveAgent` keys are `configId\0cwd`; prepareChatError
    // keys append `\0mcpKey` (empty when no MCP selection), so a prefix
    // match finds them. Only auth-category errors re-prepare — a spawn or
    // transport failure is unrelated to the completed login.
    const projectId = useProjectStore.getState().activeProjectId
    if (!projectId) return
    for (const [reuseKey, id] of Object.entries(get().configToLiveAgent)) {
      if (id !== agentId) continue
      // S1: detached keys (`configId\0cwd\0agentId`) keep a superseded process
      // resolvable but must NEVER seed a new prepare — their third segment is
      // an agent id, so parsing it as a cwd corrupted the prepare path.
      if (isDetachedReuseKey(reuseKey)) continue
      const { configId, cwd } = parseReuseKey(reuseKey)
      for (const [errKey, err] of Object.entries(get().prepareChatErrors)) {
        if (!errKey.startsWith(`${reuseKey}\0`)) continue
        if (err.category !== 'auth' && err.category !== 'multi-auth') continue
        get().cancelPreparedChat(errKey)
        get().prepareChat(configId, cwd, undefined, projectId)
      }
    }
  },

  authenticateAgent: async (agentId, methodId) => {
    // Normalize and validate BEFORE the dedup check (P5 parity with
    // `authenticateBeforeSession`): an empty/whitespace method id is unusable
    // and must be rejected up front instead of being sent to the agent, and an
    // invalid click must never resolve onto another method's in-flight
    // authenticate.
    const normalizedMethodId = methodId.trim()
    if (!normalizedMethodId) {
      throw new Error('Cannot sign in: the agent advertised an empty authentication method id.')
    }
    // The launcher only renders advertised methods; guard the store boundary
    // too so a stale click cannot send a method the agent no longer lists
    // (agents with no advertised methods are left alone — e.g. a method that
    // appears only after spawn).
    const advertisedIds = (get().agents[agentId]?.authMethods ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
      .filter((id) => id.length > 0)
    if (advertisedIds.length > 0 && !advertisedIds.includes(normalizedMethodId)) {
      throw new Error('Cannot sign in: this authentication method is no longer advertised.')
    }
    // Share a single in-flight authenticate with `authenticateBeforeSession`
    // (P2): a launcher Sign-in click concurrent with a background
    // `prepareChat` must issue one round-trip, not two. Keyed by agent+method —
    // an explicit click for method B must NOT resolve onto remembered method
    // A's in-flight auto-authenticate (a different method is a different
    // request); only same-method concurrency dedupes.
    const flightKey = inFlightAuthKey(agentId, normalizedMethodId)
    const existing = inFlightAuth.get(flightKey)
    if (existing) {
      // The shared round-trip authenticates the agent; its post-success side
      // effects (flag, memory, browser-open cleanup) ran in the owning task.
      await existing
      return
    }
    const promise = (async (): Promise<boolean> => {
      try {
        // Record the attempted method so `completeBrowserAuth` (the OAuth
        // redirect lands out-of-band without an authenticate reply) can
        // persist the winning method id per config.
        lastAuthAttempt.set(agentId, normalizedMethodId)
        await acpApi.authenticate(agentId, normalizedMethodId)
      } catch (err) {
        // Redacted (see `authenticateBeforeSession`): no method id, no raw
        // error text — an agent's auth failure may echo credentials.
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.authenticateAgent',
          message: 'Agent authenticate request failed'
        })
        throw err
      }
      // Remember success so the next `createSession` skips its own authenticate.
      authenticatedAgents.add(agentId)
      // Persist the winning method id per config so the NEXT agent process
      // (new worktree cwd, project switch, app restart) can auto-authenticate
      // on demand instead of re-showing the method picker — ONLY when the
      // method can auto-run again: a terminal/env_var login is interactive-
      // only and remembering it would wedge auto-auth on a dead pick. A
      // method missing from the advertised list carries no type → treated as
      // untyped legacy → eligible.
      const configId = configIdForAgentId(get(), agentId)
      const method = (get().agents[agentId]?.authMethods ?? []).find(
        (m) => m.id.trim() === normalizedMethodId
      )
      if (configId && (method?.type === 'agent' || method?.type == null)) {
        rememberAuthMethodForConfig(configId, normalizedMethodId)
      }
      // Auth succeeded — a pending browser-open request for this agent is
      // resolved; drop it so the dialog dismisses.
      get().clearPendingBrowserOpen(agentId)
      return true
    })().finally(() => {
      // Identity guard (see `authenticateBeforeSession`): a late cleanup must
      // never delete a newer in-flight entry for the same agent+method.
      if (inFlightAuth.get(flightKey) === promise) inFlightAuth.delete(flightKey)
    })
    inFlightAuth.set(flightKey, promise)
    await promise
  },

  // --- Event reducers ------------------------------------------------------

  _onAgentSpawned: (e) =>
    set((s) => {
      const existing = s.agents[e.agentId]
      // Promote a browser-open request captured before registration — the
      // shim watcher can emit before `agent_spawned` arrives.
      const early = earlyBrowserOpen.get(e.agentId)
      earlyBrowserOpen.delete(e.agentId)
      return {
        agents: {
          ...s.agents,
          [e.agentId]: {
            id: e.agentId,
            // CAP-4: the spawn response is authoritative. The event is
            // observer-only — it must not clobber fields already populated
            // by the response. Use the event's value only as a fallback for
            // entries the response hasn't set yet (e.g., event arrives before
            // the response resolves on desktop).
            capabilities: existing?.capabilities ?? e.capabilities,
            // Retain advertised auth methods so `authenticateBeforeSession`
            // can authenticate on demand when a session call reports
            // auth-required. Same preserve-then-fallback pattern.
            authMethods: existing?.authMethods ?? e.authMethods ?? [],
            hostAuthReady: existing?.hostAuthReady ?? e.hostAuthReady
          }
        },
        agentStatus: {
          ...s.agentStatus,
          [e.agentId]: 'connected'
        },
        ...(early !== undefined
          ? { pendingBrowserOpen: { ...s.pendingBrowserOpen, [e.agentId]: early } }
          : {})
      }
    }),

  _onAgentError: (e) => {
    const sessionId = e.sessionId
    const hadCommit = sessionId ? commitMessageCollectors.has(sessionId) : false
    const hadAssist = sessionId ? terminalAssistCollectors.has(sessionId) : false
    if (hadCommit && sessionId)
      rejectCommitMessageCollector(sessionId, e.message || 'The ACP agent reported an error')
    if (hadAssist && sessionId)
      rejectTerminalAssistCollector(sessionId, e.message || 'The ACP agent reported an error')
    if (hadCommit || hadAssist) return
    // Flush coalesced updates so the error reflects the final transcript state.
    flushCoalescedSync()
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      if (e.sessionId && s.sessions[e.sessionId] && s.sessions[e.sessionId].status !== 'closed') {
        return {
          agentStatus,
          // Finalize streaming markers: the turn is over (errored), and the
          // persist below must not capture a message mid-shimmer.
          messages: finalizeStreaming(s.messages, e.sessionId),
          sessions: {
            ...s.sessions,
            [e.sessionId]: {
              ...s.sessions[e.sessionId],
              // Story 1.9 NFR7: a turn-scoped error (incl. the bounded turn
              // timeout) sets `status: 'error'` so the UI shows the Error state
              // (the agent may be wedged — the user should see an error, not
              // a perpetually-active turn). The `_onAgentDisconnected` reducer
              // now preserves the 'error' status (it skips 'error' sessions).
              status: 'error' as SessionStatus,
              lastError: e.message,
              activeTurn: false,
              openTurnId: null
            }
          }
        }
      }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = {
            ...sessions[id],
            lastError: e.message,
            activeTurn: false,
            openTurnId: null
          }
        }
      }
      return { agentStatus, sessions }
    })
    // A turn that errored still produced transcript content (partial reply);
    // mirror it to disk so a restart doesn't lose it. Skip sessions that are
    // no longer in the index — persisting would resurrect a deleted chat.
    if (
      e.sessionId &&
      get().sessions[e.sessionId] &&
      get().sessionIndex.some((entry) => entry.id === e.sessionId)
    ) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
  },

  // Story 1.9 FR26: the agent subprocess crashed mid-turn. Mirrors
  // `_onAgentError` (sets `agentStatus[agentId]='error'`, finalizes streaming,
  // sets `lastError`, persists) but is the typed crash event emitted BEFORE
  // `agent_error` + `agent_disconnected`. The UI shows a manual-restart action
  // (no silent respawn, honoring ADR-003).
  _onAgentCrashed: (e) => {
    const sessionId = e.sessionId
    const hadCommit = sessionId ? commitMessageCollectors.has(sessionId) : false
    const hadAssist = sessionId ? terminalAssistCollectors.has(sessionId) : false
    if (hadCommit && sessionId)
      rejectCommitMessageCollector(sessionId, e.message || 'The ACP agent crashed')
    if (hadAssist && sessionId)
      rejectTerminalAssistCollector(sessionId, e.message || 'The ACP agent crashed')
    if (hadCommit || hadAssist) return
    // Flush coalesced updates so the crash reflects the final transcript state.
    flushCoalescedSync()
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      // Story 1.9 review: don't resurrect a closed session to 'error' (a late
      // crash event for an already-closed session should not overwrite its
      // terminal status).
      if (e.sessionId && s.sessions[e.sessionId] && s.sessions[e.sessionId].status !== 'closed') {
        return {
          agentStatus,
          messages: finalizeStreaming(s.messages, e.sessionId),
          sessions: {
            ...s.sessions,
            [e.sessionId]: {
              ...s.sessions[e.sessionId],
              status: 'error' as SessionStatus,
              lastError: e.message,
              activeTurn: false,
              openTurnId: null
            }
          }
        }
      }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = {
            ...sessions[id],
            status: 'error' as SessionStatus,
            lastError: e.message,
            activeTurn: false,
            openTurnId: null
          }
        }
      }
      return { agentStatus, sessions }
    })
    if (
      e.sessionId &&
      get().sessions[e.sessionId] &&
      get().sessionIndex.some((entry) => entry.id === e.sessionId)
    ) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
  },

  _onAgentDisconnected: (e) => {
    for (const [sessionId, collector] of commitMessageCollectors) {
      if (collector.agentId === e.agentId) {
        rejectCommitMessageCollector(sessionId, 'The ACP agent disconnected')
      }
    }
    for (const [sessionId, collector] of terminalAssistCollectors) {
      if (collector.agentId === e.agentId) {
        rejectTerminalAssistCollector(sessionId, 'The ACP agent disconnected')
      }
    }
    // Flush coalesced updates so the disconnect reflects the final transcript state.
    flushCoalescedSync()
    // The process is gone — drop its cached auth so a re-spawn re-authenticates
    // (a disconnected subprocess's auth state is no longer known; without this
    // a same-id re-spawn would skip `authenticate` and a stopped agent would
    // accumulate a stale auth entry).
    authenticatedAgents.delete(e.agentId)
    dropInFlightAuthForAgent(e.agentId)
    lastAuthAttempt.delete(e.agentId)
    const affected: SessionId[] = []
    const dropTranscriptIds: SessionId[] = []
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          // A session the user actually chatted in (non-empty transcript) must
          // survive an agent disconnect: keep the record + in-memory transcript so
          // the panel shows history + "disconnected" (recoverable) instead of
          // blanking, and persist it so a later reopen can replay it. Only a
          // truly-empty pooled (ephemeral) session is dropped to avoid orphan
          // "Untitled Chat" entries.
          const hasContent = (s.messages[id]?.length ?? 0) > 0
          if (ephemeralSessionIds.has(id) && !hasContent) {
            delete sessions[id]
            ephemeralSessionIds.delete(id)
            dropTranscriptIds.push(id)
          } else {
            if (ephemeralSessionIds.has(id)) ephemeralSessionIds.delete(id)
            // Story 1.9 review: a session already in 'error' status (set by the
            // preceding _onAgentCrashed event) must NOT be overwritten to 'closed'
            // — the crash's distinguishing Error state must survive the always-
            // following disconnect event so the UI can show a manual-restart
            // action.
            if (sessions[id].status !== 'error') {
              sessions[id] = {
                ...sessions[id],
                status: 'closed',
                activeTurn: false,
                openTurnId: null,
                replaying: null,
                // A retired session can never execute its armed switch —
                // clear it so a later send surfaces the closed-session
                // rejection instead of routing into switchAgent.
                switching: null
              }
            }
            affected.push(id)
            // Keep the transcript in memory for content sessions (recoverable +
            // visible); free WebView heap only for empty ones.
            if (!hasContent) dropTranscriptIds.push(id)
          }
        }
      }
      const discoveredSessions = { ...s.discoveredSessions }
      // Keys are `discoveryKey(agentId, cwd)`; drop every cwd slot for this agent.
      const prefix = `${e.agentId}\0`
      for (const k of Object.keys(discoveredSessions)) {
        if (k.startsWith(prefix)) delete discoveredSessions[k]
      }
      // Drop pooled (ephemeral) prepared sessions whose backend just died so a
      // later `startChat` does not try to promote a closed session. The match
      // reads the original state (s.sessions) so it is independent of the
      // ephemeral-session deletions in the loop above; the pool re-seeds
      // lazily on the next chat.
      const preparedSessions = dropPreparedSlots(
        s.preparedSessions,
        (sid) => s.sessions[sid]?.agentId === e.agentId
      )
      return {
        agentStatus,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, e.agentId),
        pendingQuestions: dropQuestionsForAgent(s.pendingQuestions, e.agentId),
        discoveredSessions,
        preparedSessions
      }
    })
    // A dead process can never finish its browser-open flow — drop the
    // captured URL so the dialog dismisses.
    get().clearPendingBrowserOpen(e.agentId)
    // Persist closed status + transcript while maps still hold content, then
    // free WebView heap for every session this disconnect retired.
    for (const id of affected) {
      persistSession(get(), id, (entries) => set({ sessionIndex: entries }))
    }
    if (dropTranscriptIds.length > 0) {
      set((s) => {
        let next: Pick<
          AcpState,
          'messages' | 'toolCalls' | 'agentSwitches' | 'commands' | 'sessionUsage' | 'plans'
        > = s

        for (const id of dropTranscriptIds) {
          next = dropSessionTranscriptState(next, id)
        }
        return next
      })
    }
  },

  _onBrowserOpenRequest: (e) => {
    // Headless ACP auth: the host's browser-open shim captured the URL the
    // agent tried to open. Record it so the BrowserAuthDialogHost shows the
    // dialog; cleared on auth success / kill / disconnect / dismiss.
    // Guards: the shim can capture non-URL stdout lines (only http(s) is a
    // real open request). An event for an agent that is already gone would
    // leave an entry nothing can ever clear — but the shim watcher can also
    // emit BEFORE `agent_spawned` registers the agent, so unknown ids are
    // buffered and promoted by `_onAgentSpawned` instead of dropped.
    if (typeof e.agentId !== 'string' || e.agentId.length === 0) return
    if (typeof e.url !== 'string' || !/^https?:\/\//i.test(e.url)) return
    if (!(e.agentId in get().agents)) {
      // Bound the pre-registration buffer: an event for an agent that never
      // registers (spawn failed, stale id) must not grow it without limit.
      while (earlyBrowserOpen.size >= 32) {
        const oldest = earlyBrowserOpen.keys().next().value
        if (oldest === undefined) break
        earlyBrowserOpen.delete(oldest)
        void logFrontendError({
          level: 'warn',
          message: `[acp] early browser-open buffer evicted oldest entry (agentId=${oldest}, size=${earlyBrowserOpen.size})`,
          source: 'acp-store:_onBrowserOpenRequest'
        })
      }
      earlyBrowserOpen.set(e.agentId, e.url)
      void logFrontendError({
        level: 'info',
        message: `[acp] browser-open request buffered pending agent registration (agentId=${e.agentId})`,
        source: 'acp-store:_onBrowserOpenRequest'
      })
      return
    }
    set((s) => ({ pendingBrowserOpen: { ...s.pendingBrowserOpen, [e.agentId]: e.url } }))
  }
})
