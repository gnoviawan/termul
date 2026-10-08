/**
 * Config slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import {
  loadAgentConfigs as loadAgentConfigsFromDisk,
  saveAgentConfigs as saveAgentConfigsToDisk
} from '@/lib/acp-agents-persistence'
import { type AgentId, acpApi } from '@/lib/acp-api'
import { loadAuthMethodMemory as loadAuthMethodMemoryFromDisk } from '@/lib/acp-auth-method-memory'
import { migrateRetiredCodexConfig } from '@/lib/agents/supported-acp-agents'
import { logFrontendError } from '@/lib/log-api'
import { configIdFromReuseKey, parseReuseKey } from '../../acp-reuse-keys'
import {
  type AgentUpdateStoreDeps,
  applyAgentUpdateFlow,
  detachAgentForNewCredentials as detachAgentForNewCredentialsFlow
} from '../../agent-update-orchestration'
import { agentConfigIdentityChanged, invalidateAgentOptionsCache, normalizeCwd } from '../helpers'
import {
  ensureLiveAgent,
  inFlightPrepared,
  inFlightWarms,
  isEphemeralAcpSession
} from '../shared-state'
import type { AcpGet, AcpSet, AcpState } from '../types'
import {
  forgetAuthMethodForConfig,
  forgottenAuthMethodConfigs,
  rememberedAuthMethods
} from './agent'

/**
 * Store-provided collaborators for the agent-update orchestration module
 * (which owns `applyAgentUpdate` / `detachAgentForNewCredentials` /
 * `teardownConfigForUpdate` — see `agent-update-orchestration.ts`).
 */
function agentUpdateDeps(get: AcpGet, set: AcpSet): AgentUpdateStoreDeps {
  return {
    get,
    set,
    inFlightWarms,
    inFlightPrepared,
    isEphemeralSession: isEphemeralAcpSession,
    invalidateOptionsCache: invalidateAgentOptionsCache
  }
}

type ConfigSliceState = Pick<
  AcpState,
  | 'agentConfigs'
  | 'configToLiveAgent'
  | 'warmingConfigs'
  | 'agentOptionsCache'
  | 'selectedAgentConfigId'
  | 'loadAgentConfigs'
  | 'saveAgentConfig'
  | 'applyAgentUpdate'
  | 'deleteAgentConfig'
  | 'prewarmAgent'
  | 'detachAgentForNewCredentials'
  | 'testConnection'
  | 'setSelectedAgentConfigId'
  | 'retargetWarmPool'
>

export const createConfigSlice: StateCreator<AcpState, [], [], ConfigSliceState> = (set, get) => ({
  agentConfigs: [],
  configToLiveAgent: {},
  warmingConfigs: {},
  agentOptionsCache: {},
  selectedAgentConfigId: null,

  loadAgentConfigs: async () => {
    try {
      const loaded = await loadAgentConfigsFromDisk()
      let changed = false
      const configs = loaded.map((config) => {
        const migrated = migrateRetiredCodexConfig(config)
        if (!migrated) return config
        changed = true
        return migrated
      })
      set({ agentConfigs: configs })
      if (changed) {
        try {
          const fresh = await loadAgentConfigsFromDisk()
          const migratedById = new Map(
            configs.flatMap((config, index) =>
              config !== loaded[index] ? [[config.id, config] as const] : []
            )
          )
          const merged = fresh.map((config) => {
            const migrated = migratedById.get(config.id)
            if (!migrated) return config
            const original = loaded.find((item) => item.id === config.id)
            if (original && JSON.stringify(original) === JSON.stringify(config)) return migrated
            return config
          })
          await saveAgentConfigsToDisk(merged)
        } catch (error) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.loadAgentConfigs',
            message: `Codex config migration was kept in memory but not saved: ${error instanceof Error ? error.message : String(error)}`
          })
        }
      }
    } catch {
      // A real storage/backend error is surfaced by the persistence layer; at the
      // store level we log and leave the list empty rather than crashing app
      // mount. (A missing key already returns [] without throwing.) Routed
      // through log-api rather than console.* — an async console write that
      // lands after a test run's last tick races vitest's worker RPC teardown
      // ("onUserConsoleLog pending") and has failed CI on otherwise green runs
      // (seen on #689 and #690's CI runs).
      void logFrontendError({
        level: 'warn',
        source: 'acp.loadAgentConfigs',
        message: 'failed to load agent configs; leaving the list empty'
      })
    }
    // The remembered auth-method map (spec-acp-persistent-auth-reuse) rides the
    // same init boundary so `authenticateBeforeSession` can auto-authenticate a
    // multi-method agent on demand. Its failure must not fail the config load —
    // an empty memory just falls back to the method picker.
    try {
      const remembered = await loadAuthMethodMemoryFromDisk()
      // Merge, never replace: this runs on every activeProjectId change and a
      // clear+repopulate could wipe a just-remembered entry whose
      // `persistAuthMethodMemory` write has not landed on disk yet. In-memory
      // entries win; tombstoned (forgotten) keys are never resurrected.
      for (const [configId, methodId] of Object.entries(remembered)) {
        if (forgottenAuthMethodConfigs.has(configId)) continue
        if (!rememberedAuthMethods.has(configId)) {
          rememberedAuthMethods.set(configId, methodId)
        }
      }
    } catch {
      void logFrontendError({
        level: 'warn',
        source: 'acp.loadAgentConfigs',
        message: 'failed to load remembered auth methods; auto-auth falls back to the picker'
      })
    }
  },

  saveAgentConfig: async (config) => {
    const list = get().agentConfigs
    const idx = list.findIndex((c) => c.id === config.id)
    const prev = idx === -1 ? undefined : list[idx]
    const next = idx === -1 ? [...list, config] : list.map((c) => (c.id === config.id ? config : c))
    set({ agentConfigs: next })
    try {
      await saveAgentConfigsToDisk(next)
    } catch (err) {
      // roll back the in-memory change on persistence failure
      set({ agentConfigs: list })
      throw err
    }
    // Invalidate options cache only on identity-changing fields (cmd/args/env).
    // Do not kill warm agents here — that remains deleteAgentConfig's job.
    if (agentConfigIdentityChanged(prev, config)) {
      invalidateAgentOptionsCache(set, config.id)
    }
  },
  applyAgentUpdate: (configId, agent) =>
    // Delegated to the agent-update orchestration module (in-flight dedupe,
    // managed-npm/archive/runnable derivation, teardown + pending-restart
    // bookkeeping live there).
    applyAgentUpdateFlow(agentUpdateDeps(get, set), configId, agent),

  deleteAgentConfig: async (id) => {
    const list = get().agentConfigs
    const next = list.filter((c) => c.id !== id)
    set({ agentConfigs: next })
    try {
      await saveAgentConfigsToDisk(next)
    } catch (err) {
      set({ agentConfigs: list })
      throw err
    }
    // Tear down every per-project warmed process for this config so none can be
    // reused stale. The reuse map and warm map are keyed by config+cwd, so a
    // single config may own several live processes (one per project/cwd).
    // Await each in-flight warm first: its spawn may not have registered the
    // agent id yet, and without this the just-spawned process would leak.
    const reuseKeys = new Set<string>([
      ...Object.keys(get().configToLiveAgent),
      ...inFlightWarms.keys()
    ])
    const targets = [...reuseKeys].filter((k) => configIdFromReuseKey(k) === id)
    const warmAgents: AgentId[] = []
    for (const key of targets) {
      const pending = inFlightWarms.get(key)
      const warm = pending ? await pending : get().configToLiveAgent[key]
      if (warm) warmAgents.push(warm)
    }
    if (warmAgents.length > 0) {
      set((s) => {
        const map = { ...s.configToLiveAgent }
        for (const key of targets) delete map[key]
        return { configToLiveAgent: map }
      })
      for (const warm of warmAgents) {
        try {
          await get().killAgent(warm)
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    // Drop prepared sessions for this config so a later re-enable can't consume
    // stale prepare keys (prepareChatKey also starts with configId\0…).
    const prepareKeys = new Set<string>([
      ...Object.keys(get().preparedSessions),
      ...Object.keys(get().preparingChatKeys),
      ...Object.keys(get().prepareChatErrors),
      ...inFlightPrepared.keys()
    ])
    for (const key of prepareKeys) {
      if (configIdFromReuseKey(key) !== id) continue
      get().cancelPreparedChat(key)
    }
    // Orphaned memory (spec-acp-persistent-auth-reuse): a deleted config's
    // remembered sign-in method must not stay on disk and be inherited by a
    // recreated config that reuses the same id.
    forgetAuthMethodForConfig(id)
    invalidateAgentOptionsCache(set, id)
  },

  prewarmAgent: async (configId, cwd) => {
    await ensureLiveAgent(get, set, configId, cwd, {
      registerWarmUi: true,
      silentSpawnFailure: true
    })
  },

  detachAgentForNewCredentials: (configId, cwd) => {
    // Delegated to the agent-update orchestration module: cancels prepared
    // work for the reuse key and re-maps a superseded live process under a
    // detached reuse key (see `acp-reuse-keys.ts`).
    detachAgentForNewCredentialsFlow(agentUpdateDeps(get, set), configId, cwd)
  },

  testConnection: async (config) => {
    let agentId: AgentId | null = null
    try {
      // The spawn response now carries the authoritative capabilities
      // (CAP-4: the response — not the async event — is the source of truth),
      // so the former 3s store-poll wait is unnecessary: capabilities are
      // available synchronously from `result.capabilities`.
      const result = await acpApi.spawnAgent(config)
      agentId = result.agentId
      return result.capabilities
    } finally {
      // Always clean up the test process.
      if (agentId) {
        try {
          await acpApi.killAgent(agentId)
        } catch {
          /* best-effort cleanup */
        }
        const id = agentId
        set((s) => {
          const agents = { ...s.agents }
          const agentStatus = { ...s.agentStatus }
          delete agents[id]
          delete agentStatus[id]
          return { agents, agentStatus }
        })
      }
    }
  },

  setSelectedAgentConfigId: (configId) => set({ selectedAgentConfigId: configId }),

  retargetWarmPool: (configId, cwd, projectId) => {
    const trimmedCwd = cwd.trim()
    if (!configId || trimmedCwd.length === 0) return
    // Agent-switch drain (single-target): close + drop pooled sessions for THIS
    // cwd but a DIFFERENT agent. Sessions for other cwds stay warm so switching
    // projects back is instant (per-cwd warm, like processes). Idempotent: a
    // retarget to the same target drains nothing and `prepareChat` dedupes the seed.
    const state = get()
    const targetCwd = normalizeCwd(trimmedCwd)
    for (const k of new Set([
      ...Object.keys(state.preparedSessions),
      ...Object.keys(state.preparingChatKeys)
    ])) {
      const { configId: kConfig, cwd: kCwd } = parseReuseKey(k)
      if (kConfig !== configId && normalizeCwd(kCwd) === targetCwd) {
        get().cancelPreparedChat(k)
      }
    }
    // Seed the new target (fire-and-forget; prepareChat dedupes in-flight work
    // and is silent on failure — chat still lazy-spawns if the warm-up fails).
    void get().prepareChat(configId, trimmedCwd, undefined, projectId, { silent: true })
  }
})
