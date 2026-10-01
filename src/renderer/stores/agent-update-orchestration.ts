/**
 * Agent-update orchestration for the ACP store.
 *
 * Owns the "Update Application" concern end to end: the in-flight update
 * dedupe map, the post-install teardown of a config's warm/prepared state,
 * the pending-restart bookkeeping, and credential-change detaching. Extracted
 * from `acp-store.ts` (same pattern as `prompt-queue-orchestration.ts`); the
 * store's actions delegate here with a small deps object, so no store shape
 * or middleware changes.
 */

import type { AgentId, SessionId } from '@/lib/acp-api'
import { getAcpTransport } from '@/lib/acp-transport'
import {
  agentPolicy,
  deriveAgentConfig,
  type RegistryAgent,
  registryOsFromHostOs
} from '@/lib/agents/acp-registry'
import { acpCatalogApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey, configIdFromReuseKey, detachedReuseKey } from './acp-reuse-keys'
import type { AcpGet, AcpSet, AcpState } from './acp-store'

/**
 * Store-provided collaborators for the update flow. The store keeps the
 * shared module-level maps (`inFlightWarms`, `inFlightPrepared`), the
 * ephemeral-session tracking, and the options-cache helper; this module never
 * imports runtime values back from `acp-store` (type-only import only).
 */
export interface AgentUpdateStoreDeps {
  get: AcpGet
  set: AcpSet
  /** Shared warm-spawn map keyed by reuse key (lives in `acp-store`). */
  inFlightWarms: Map<string, Promise<AgentId | null>>
  /** Shared prepare dedupe map keyed by prepare key (lives in `acp-store`). */
  inFlightPrepared: Map<string, Promise<SessionId | null>>
  /** True when a session is backend-ephemeral (store-tracked). */
  isEphemeralSession: (sessionId: SessionId) => boolean
  /** Drops the agent options cache for a config. */
  invalidateOptionsCache: (set: AcpSet, configId: string) => void
}

/**
 * In-flight Update Applications keyed by config id so concurrent
 * `applyAgentUpdate` calls for the same config (double-click, launcher +
 * Settings at once) join the running install instead of re-downloading the
 * archive (QA: one binary agent was re-installed 6× from 6 clicks). Settled
 * (or failed) entries are removed so a later retry starts fresh.
 */
const inFlightAgentUpdates = new Map<string, Promise<'applied' | 'unchanged'>>()

/**
 * Update Application follow-through: tear down a config's warm/prepared state
 * so the NEXT chat for this config spawns the applied version instead of
 * claiming a stale warm process (QA: a post-update new chat reused the old
 * binary and the pending-restart banner never cleared). Warm processes with NO
 * open sessions are killed outright; a live agent (open chat) keeps its
 * process — only the reuse mapping detaches, mirroring
 * `detachAgentForNewCredentials`, so the running chat is never interrupted.
 */
export async function teardownConfigForUpdate(
  deps: AgentUpdateStoreDeps,
  configId: string
): Promise<void> {
  const { get, set, inFlightWarms, inFlightPrepared, invalidateOptionsCache } = deps
  const reuseKeys = new Set<string>([
    ...Object.keys(get().configToLiveAgent),
    ...inFlightWarms.keys()
  ])
  const targets = [...reuseKeys].filter((k) => configIdFromReuseKey(k) === configId)
  for (const key of targets) {
    const pending = inFlightWarms.get(key)
    const agentId = pending ? await pending : get().configToLiveAgent[key]
    const mapped = get().configToLiveAgent[key]
    const hasOpenSession =
      agentId != null && Object.values(get().sessions).some((s) => s.agentId === agentId)
    // Detach the reuse mapping unconditionally (an in-flight warm that never
    // registered leaves a dangling key; deleting a missing key is a no-op).
    if (mapped != null) {
      set((s) => {
        if (s.configToLiveAgent[key] !== mapped) return s
        const map = { ...s.configToLiveAgent }
        delete map[key]
        return { configToLiveAgent: map }
      })
    }
    // Kill only idle processes — an open chat keeps running the old binary
    // with the banner explaining, per the no-kill live-session rule.
    if (agentId != null && !hasOpenSession) {
      try {
        await get().killAgent(agentId)
      } catch {
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.teardownConfigForUpdate',
          message: `Could not stop idle ACP process after updating ${configId} (agent ${agentId})`
        })
      }
    }
  }
  // Drop prepared sessions for this config so a next chat can't consume a
  // prepare keyed to the pre-update binary.
  const prepareKeys = new Set<string>([
    ...Object.keys(get().preparedSessions),
    ...Object.keys(get().preparingChatKeys),
    ...Object.keys(get().prepareChatErrors),
    ...inFlightPrepared.keys()
  ])
  for (const key of prepareKeys) {
    if (configIdFromReuseKey(key) !== configId) continue
    get().cancelPreparedChat(key)
  }
  invalidateOptionsCache(set, configId)
}

/**
 * Body of the store's `applyAgentUpdate` action (dedupe included). See the
 * store action for the state contract.
 */
export function applyAgentUpdateFlow(
  deps: AgentUpdateStoreDeps,
  configId: string,
  agent: RegistryAgent
): Promise<'applied' | 'unchanged'> {
  const { get, set } = deps
  const inFlight = inFlightAgentUpdates.get(configId)
  if (inFlight) return inFlight
  const apply = (async () => {
    try {
      const existing = get().agentConfigs.find((c) => c.id === configId)
      if (!existing) return 'unchanged'
      // Resolve the host platform-arch from the catalog (the host is the single
      // source of truth — the renderer never probes plugin-os locally).
      const catalog = await acpCatalogApi.listCatalog()
      if (!catalog.success) {
        throw new Error(catalog.error ?? 'Could not resolve the host catalog')
      }
      const os = registryOsFromHostOs(catalog.data.host.os)
      const platformArch = `${os}-${catalog.data.host.arch}`
      const derived = deriveAgentConfig(agent, platformArch)
      // Env merge (ADR-0002): persisted values win on conflict, registry keys the
      // persisted config lacks are filled in, and nothing user-added is dropped.
      const mergeEnv = (registryEnv: Record<string, string>) => ({
        ...registryEnv,
        ...existing.env
      })
      // Shared tail: drop warm/prepared state so the next chat spawns the
      // applied version instead of claiming a stale warm process; the live
      // process still runs the old binary — record the pending restart so
      // chat surfaces the next-spawn banner.
      const finishApply = async (): Promise<'applied'> => {
        await teardownConfigForUpdate(deps, configId)
        set((s) => ({
          pendingRestartVersions: { ...s.pendingRestartVersions, [configId]: agent.version }
        }))
        return 'applied'
      }
      if (agentPolicy(agent.id).install.kind === 'managed-npm') {
        // Managed npm install (S2-TS policy): update through the same host
        // install seam as first install; never rewrite it back to an npx
        // launcher that can resolve an unpinned package at spawn.
        const installed = await getAcpTransport().installAcpAgent(agent.id)
        const env = mergeEnv({})
        // Old Claude templates carried an unresolved/inline API-key value.
        // New auth is host-keychain-only, so do not migrate that value into
        // the replacement config.
        delete env.ANTHROPIC_API_KEY
        await get().saveAgentConfig({
          ...existing,
          name: agent.name,
          command: installed.command,
          args: installed.args,
          env
        })
        return await finishApply()
      }
      if (derived.kind === 'needs-install') {
        // Binary agent: Update Application = verified-atomic host re-install
        // (sha256-checked archive), then overwrite from the install outcome.
        if (!derived.archiveUrl) {
          throw new Error(`Agent ${agent.id} requires a manual install; update it outside Termul`)
        }
        const installed = await getAcpTransport().installAcpAgent(agent.id)
        await get().saveAgentConfig({
          ...existing,
          name: agent.name,
          command: installed.command,
          args: installed.args,
          env: mergeEnv(derived.env)
        })
        return await finishApply()
      }
      if (derived.kind !== 'runnable') {
        throw new Error(`Agent ${agent.id} has no runnable distribution on this platform`)
      }
      await get().saveAgentConfig({
        ...existing,
        name: derived.config.name,
        command: derived.config.command,
        args: derived.config.args,
        env: mergeEnv(derived.config.env),
        allowTerminal: derived.config.allowTerminal
      })
      return await finishApply()
    } finally {
      inFlightAgentUpdates.delete(configId)
    }
  })()
  inFlightAgentUpdates.set(configId, apply)
  return apply
}

/**
 * Body of the store's `detachAgentForNewCredentials` action: cancel prepared
 * work keyed to the reuse key, then preserve the old process (and its active
 * sessions) under a DETACHED reuse key so only future launches consume the
 * newly stored credentials.
 */
export function detachAgentForNewCredentials(
  deps: AgentUpdateStoreDeps,
  configId: string,
  cwd: string
): void {
  const { get, set, isEphemeralSession } = deps
  const reuseKey = agentReuseKey(configId, cwd)
  for (const key of [
    ...Object.keys(get().preparedSessions),
    ...Object.keys(get().preparingChatKeys),
    ...Object.keys(get().prepareChatErrors)
  ]) {
    if (key.startsWith(`${reuseKey}\0`)) get().cancelPreparedChat(key)
  }
  // Preserve the old process and its active sessions. Only future launches
  // may consume the newly stored credentials.
  set((s) => {
    const configToLiveAgent = { ...s.configToLiveAgent }
    const previousAgent = configToLiveAgent[reuseKey]
    delete configToLiveAgent[reuseKey]
    if (
      previousAgent &&
      Object.values(s.sessions).some(
        (session) =>
          session.agentId === previousAgent &&
          session.status !== 'closed' &&
          !isEphemeralSession(session.id)
      )
    ) {
      // Keep the old agent resolvable for live chat history, model changes,
      // and cleanup, without allowing the next prepare to reuse its key.
      configToLiveAgent[detachedReuseKey(reuseKey, previousAgent)] = previousAgent
    }
    return { configToLiveAgent }
  })
}

/**
 * Clear `pendingRestartVersions` after a user-facing chat for this config
 * is created. Spawn and warm-pool prepares must not call this — a failed
 * session after spawn would hide Restart, and an ephemeral prepare is not
 * a chat the user opened.
 */
export function pendingRestartVersionsAfterSpawn(
  state: Pick<AcpState, 'pendingRestartVersions'>,
  configId: string | undefined
): Record<string, string> {
  const pendingRestartVersions = { ...state.pendingRestartVersions }
  if (configId) delete pendingRestartVersions[configId]
  return pendingRestartVersions
}
