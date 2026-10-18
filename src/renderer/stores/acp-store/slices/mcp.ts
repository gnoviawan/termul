/**
 * Mcp slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import { toast } from 'sonner'
import type { StateCreator } from 'zustand'
import { acpApi, type McpServerConfig, type ProbeResult } from '@/lib/acp-api'
import {
  loadMcpServers as loadMcpServersFromDisk,
  type StoredMcpServer,
  saveMcpServers as saveMcpServersToDisk,
  syncMcpRegistryToProjectBestEffort
} from '@/lib/acp-mcp-persistence'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useProjectStore } from '@/stores/project-store'
import type { AcpState } from '../types'

// MCP registry mutations (save/import/toggle/delete) are serialized through a
// single promise queue. Without this, two overlapping mutations each snapshot
// `mcpServers` before their async disk write; the slower one would persist a
// stale snapshot AFTER the newer mutation (clobbering it), and its rollback on
// failure would restore that stale snapshot — dropping the intervening change.
// The queue guarantees each mutation reads, writes, and (on failure) rolls back
// against the registry state as of its own turn.
let mcpRegistryQueue: Promise<unknown> = Promise.resolve()

/** The project the host MCP file is addressed through (`''` until one is selected). */
function activeProjectId(): string {
  return useProjectStore.getState().activeProjectId
}

async function runSerializedMcpRegistryMutation(mutation: () => Promise<void>): Promise<void> {
  const run = mcpRegistryQueue.then(mutation)
  // Swallow for the chain only — the returned promise still rejects to callers.
  mcpRegistryQueue = run.catch(() => undefined)
  await run
}

type McpSliceState = Pick<
  AcpState,
  | 'mcpServers'
  | 'mcpServersLoaded'
  | 'mcpProbeStatus'
  | 'mcpOAuthConnecting'
  | 'mcpOAuthConnected'
  | 'mcpTools'
  | 'mcpToolsLoaded'
  | 'mcpProbing'
  | 'mcpProbeError'
  | 'loadMcpServers'
  | 'saveMcpServer'
  | 'importMcpServers'
  | 'setMcpServerEnabled'
  | 'deleteMcpServer'
  | 'syncMcpRegistryToProjectFile'
  | 'probeMcpServer'
  | 'loadMcpTools'
  | 'connectMcpOAuth'
  | 'checkMcpOAuthStatus'
  | 'disconnectMcpOAuth'
>

// A project-file mirror requested before the MCP registry finished loading is
// kept (with the project it named) and performed as soon as the registry loads
// (mirroring the empty pre-load state would clobber the project's file).
let projectFileMirrorPending: string | null = null

function probeConfigOf(server: StoredMcpServer): McpServerConfig {
  const { id: _id, enabled: _enabled, ...config } = server
  return config as McpServerConfig
}

function sameProbeConfig(a: StoredMcpServer, b: StoredMcpServer): boolean {
  return JSON.stringify(probeConfigOf(a)) === JSON.stringify(probeConfigOf(b))
}

type McpSliceCreator = StateCreator<AcpState, [], [], McpSliceState>

type McpProbeState = Pick<
  AcpState,
  'mcpProbeStatus' | 'mcpTools' | 'mcpToolsLoaded' | 'mcpProbing' | 'mcpProbeError'
>

function omitKey<V>(record: Record<string, V>, id: string): Record<string, V> {
  const { [id]: _dropped, ...rest } = record
  return rest
}

function withoutProbeState(s: McpProbeState, id: string): McpProbeState {
  return {
    mcpProbeStatus: omitKey(s.mcpProbeStatus, id),
    mcpTools: omitKey(s.mcpTools, id),
    mcpToolsLoaded: omitKey(s.mcpToolsLoaded, id),
    mcpProbing: omitKey(s.mcpProbing, id),
    mcpProbeError: omitKey(s.mcpProbeError, id)
  }
}

// Per-id count of completed deletions. Absence from `mcpServers` alone does not
// mean deleted: a web project switch swaps in another project's list. A probe
// or OAuth call compares the count across its await, so a deleted id's result
// never lands, even on a server re-added under the same id.
const deletionCounts = new Map<string, number>()

export function mcpServerDeletionCount(id: string): number {
  return deletionCounts.get(id) ?? 0
}

function deletionGuard(id: string): () => boolean {
  const before = mcpServerDeletionCount(id)
  return () => mcpServerDeletionCount(id) !== before
}

// Ids whose in-flight probe started before an OAuth sign-in or sign-out
// finished, so its result is stale. The host joins identical in-flight probes,
// so the fresh probe can only start once this one ends.
const reprobeAfterInFlight = new Set<string>()

function probeAfterInFlight(get: Parameters<McpSliceCreator>[1], id: string): Promise<void> {
  if (get().mcpProbing[id]) {
    reprobeAfterInFlight.add(id)
    return Promise.resolve()
  }
  return get().probeMcpServer(id)
}

// Returns null when a finished probe of `probed` should write its result.
// Otherwise the result is dropped: a server deleted mid-probe stays cleared,
// and a server whose config was edited or whose OAuth state changed is
// probed again.
function settleStaleProbe(
  set: Parameters<McpSliceCreator>[0],
  get: Parameters<McpSliceCreator>[1],
  probed: StoredMcpServer,
  wasDeleted: () => boolean
): Promise<void> | null {
  const { id } = probed
  const reprobe = reprobeAfterInFlight.delete(id)
  const deleted = wasDeleted()
  const current = get().mcpServers.find((s) => s.id === id)
  if (!current) return deleted ? Promise.resolve() : null
  if (!reprobe && sameProbeConfig(current, probed)) return null
  set((s) => ({ mcpProbing: { ...s.mcpProbing, [id]: false } }))
  if (current.enabled === false) return Promise.resolve()
  return get().probeMcpServer(id)
}

function reprobeEditedServer(
  set: Parameters<McpSliceCreator>[0],
  get: Parameters<McpSliceCreator>[1],
  server: StoredMcpServer
): void {
  set((s) => {
    const { [server.id]: _stale, ...mcpProbeStatus } = s.mcpProbeStatus
    return {
      mcpProbeStatus,
      mcpTools: { ...s.mcpTools, [server.id]: [] },
      mcpToolsLoaded: { ...s.mcpToolsLoaded, [server.id]: false },
      mcpProbeError: { ...s.mcpProbeError, [server.id]: undefined }
    }
  })
  if (server.enabled !== false) void get().probeMcpServer(server.id)
}

export const createMcpSlice: McpSliceCreator = (set, get) => ({
  mcpServers: [],
  mcpServersLoaded: false,
  mcpProbeStatus: {},
  mcpOAuthConnecting: {},
  mcpOAuthConnected: {},
  mcpTools: {},
  mcpToolsLoaded: {},
  mcpProbing: {},
  mcpProbeError: {},

  loadMcpServers: async () => {
    try {
      const list = await loadMcpServersFromDisk(activeProjectId())
      set({ mcpServers: list, mcpServersLoaded: true })
      if (projectFileMirrorPending) {
        const projectId = projectFileMirrorPending
        projectFileMirrorPending = null
        await syncMcpRegistryToProjectBestEffort(projectId, list)
      }
    } catch (err) {
      void logFrontendError({
        source: 'acp-store.loadMcpServers',
        message: `Failed to load MCP registry (${String(err)})`
      })
      toast.error('Could not load MCP servers. Try reopening Settings.')
    }
  },

  saveMcpServer: (server) =>
    runSerializedMcpRegistryMutation(async () => {
      const list = get().mcpServers
      const idx = list.findIndex((item) => item.id === server.id)
      const nextServer = { ...server, enabled: server.enabled ?? true }
      const next =
        idx === -1
          ? [...list, nextServer]
          : list.map((item) => (item.id === server.id ? nextServer : item))
      set({ mcpServers: next })
      try {
        await saveMcpServersToDisk(next, activeProjectId())
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.saveMcpServer',
          message: `Failed to persist MCP registry (${String(err)})`
        })
        throw err
      }
      const previous = list[idx]
      if (previous && !sameProbeConfig(previous, nextServer))
        reprobeEditedServer(set, get, nextServer)
    }),

  importMcpServers: async (servers) => {
    if (servers.length === 0) return
    await runSerializedMcpRegistryMutation(async () => {
      const list = get().mcpServers
      const next = [...list, ...servers]
      set({ mcpServers: next })
      try {
        await saveMcpServersToDisk(next, activeProjectId())
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.importMcpServers',
          message: `Failed to persist MCP registry import (${String(err)})`
        })
        throw err
      }
    })
  },

  setMcpServerEnabled: (id, enabled) =>
    runSerializedMcpRegistryMutation(async () => {
      const list = get().mcpServers
      const next = list.map((server) => (server.id === id ? { ...server, enabled } : server))
      set({ mcpServers: next })
      try {
        await saveMcpServersToDisk(next, activeProjectId())
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.setMcpServerEnabled',
          message: `Failed to persist MCP registry toggle (${String(err)})`
        })
        throw err
      }
    }),

  deleteMcpServer: (id) =>
    runSerializedMcpRegistryMutation(async () => {
      const list = get().mcpServers
      const next = list.filter((server) => server.id !== id)
      set({ mcpServers: next })
      try {
        await saveMcpServersToDisk(next, activeProjectId())
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.deleteMcpServer',
          message: `Failed to persist MCP registry deletion (${String(err)})`
        })
        throw err
      }
      deletionCounts.set(id, mcpServerDeletionCount(id) + 1)
      set((s) => ({
        ...withoutProbeState(s, id),
        mcpOAuthConnected: omitKey(s.mcpOAuthConnected, id),
        mcpOAuthConnecting: omitKey(s.mcpOAuthConnecting, id)
      }))
    }),

  // CAP-7: mirror the app-store MCP registry to the named project's
  // `.termul/mcp-servers.json` so the web `GET /mcp-servers?projectId=` route
  // (file-based) serves the same registry. Invoked by `useProjectRegistry` when
  // the `projects` watch reports a new default while shared-live runs, and when
  // shared-live starts. Best-effort + non-fatal — the wrapper logs failures and
  // never throws.
  syncMcpRegistryToProjectFile: async (projectId) => {
    if (!isTauriContext()) return
    if (!get().mcpServersLoaded) {
      projectFileMirrorPending = projectId
      return
    }
    await syncMcpRegistryToProjectBestEffort(projectId, get().mcpServers)
  },

  // MCP probe (on-demand, read-only). No persistence, no rollback. Dedupes
  // concurrent probes per server id via `mcpProbing`.
  probeMcpServer: async (id) => {
    if (get().mcpProbing[id]) return
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const deleted = deletionGuard(id)
    set((s) => ({ mcpProbing: { ...s.mcpProbing, [id]: true } }))
    try {
      const result: ProbeResult = await acpApi.probeMcpServer(probeConfigOf(server))
      const stale = settleStaleProbe(set, get, server, deleted)
      if (stale) return stale
      set((s) => ({
        mcpProbeStatus: { ...s.mcpProbeStatus, [id]: result.status },
        mcpTools: { ...s.mcpTools, [id]: result.tools },
        mcpToolsLoaded: { ...s.mcpToolsLoaded, [id]: true },
        mcpProbing: { ...s.mcpProbing, [id]: false },
        // Disconnected → keep the backend's (redacted) reason for the UI; a
        // successful probe clears any stale error.
        mcpProbeError: {
          ...s.mcpProbeError,
          [id]: result.status === 'connected' ? undefined : result.error
        }
      }))
    } catch (err) {
      void logFrontendError({
        source: 'acp-store.probeMcpServer',
        message: `MCP probe failed for server '${server.name}' (${String(err)})`
      })
      const stale = settleStaleProbe(set, get, server, deleted)
      if (stale) return stale
      // Transport/parse failure (NOT a disconnected probe — that's a
      // `status:'disconnected'` ProbeResult, not a throw). Surface the
      // failure in the dot + log WITHOUT env/header values, tokens, or
      // credentials. The synthetic disconnected status has no real backend
      // error to show, so the probe error is cleared.
      set((s) => ({
        mcpProbeStatus: { ...s.mcpProbeStatus, [id]: 'disconnected' },
        // A throw means the probe never produced a result — drop any tools left
        // over from a prior successful probe so the UI shows the disconnected
        // state (McpBadge checks the tool list first), and mark tools as not
        // loaded so a later expand auto-retries instead of caching the failure.
        mcpTools: { ...s.mcpTools, [id]: [] },
        mcpToolsLoaded: { ...s.mcpToolsLoaded, [id]: false },
        mcpProbing: { ...s.mcpProbing, [id]: false },
        mcpProbeError: { ...s.mcpProbeError, [id]: undefined }
      }))
    }
  },

  loadMcpTools: async (id) => {
    if (get().mcpProbing[id]) return
    const hasReachableProbeResult =
      get().mcpToolsLoaded[id] && get().mcpProbeStatus[id] !== 'disconnected'
    if (hasReachableProbeResult) return
    await get().probeMcpServer(id)
  },
  connectMcpOAuth: async (projectId, id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    const deleted = deletionGuard(id)
    set((s) => ({ mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: true } }))
    void logFrontendError({
      source: 'acp-store.connectMcpOAuth',
      message: `OAuth flow started for server '${server.name}'`
    })
    try {
      await acpApi.startMcpOAuth(projectId, url)
      // startMcpOAuth now blocks until the token is stored (desktop: the
      // Tauri command blocks; web: polls the status endpoint). Setting
      // connected state here is correct — the token is confirmed.
      if (deleted()) return
      set((s) => ({
        mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: true },
        mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: false }
      }))
      void logFrontendError({
        source: 'acp-store.connectMcpOAuth',
        message: `OAuth token confirmed for server '${server.name}'`
      })
      // Re-probe now that we have a token — should succeed.
      await probeAfterInFlight(get, id)
    } catch (err) {
      if (!deleted()) set((s) => ({ mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: false } }))
      void logFrontendError({
        source: 'acp-store.connectMcpOAuth',
        message: `OAuth flow failed for server '${server.name}' (${String(err)})`
      })
      throw err
    }
  },

  checkMcpOAuthStatus: async (projectId, id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    const deleted = deletionGuard(id)
    try {
      const hasToken = await acpApi.hasMcpOAuthToken(projectId, url)
      if (deleted()) return
      set((s) => ({ mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: hasToken } }))
    } catch {
      // Best-effort — the probe will still detect authRequired.
    }
  },

  disconnectMcpOAuth: async (projectId, id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    const deleted = deletionGuard(id)
    try {
      await acpApi.disconnectMcpOAuth(projectId, url)
      if (deleted()) return
      set((s) => ({ mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: false } }))
      void logFrontendError({
        source: 'acp-store.disconnectMcpOAuth',
        message: `OAuth disconnect completed for server '${server.name}'`
      })
      // Re-probe — should return authRequired again.
      await probeAfterInFlight(get, id)
    } catch (err) {
      void logFrontendError({
        source: 'acp-store.disconnectMcpOAuth',
        message: `OAuth disconnect failed for server '${server.name}' (${String(err)})`
      })
      throw err
    }
  }
})
