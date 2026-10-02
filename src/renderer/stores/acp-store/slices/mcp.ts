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
import type { AcpState } from '../types'

// MCP registry mutations (save/import/toggle/delete) are serialized through a
// single promise queue. Without this, two overlapping mutations each snapshot
// `mcpServers` before their async disk write; the slower one would persist a
// stale snapshot AFTER the newer mutation (clobbering it), and its rollback on
// failure would restore that stale snapshot — dropping the intervening change.
// The queue guarantees each mutation reads, writes, and (on failure) rolls back
// against the registry state as of its own turn.
let mcpRegistryQueue: Promise<unknown> = Promise.resolve()

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

export const createMcpSlice: StateCreator<AcpState, [], [], McpSliceState> = (set, get) => ({
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
      const list = await loadMcpServersFromDisk()
      set({ mcpServers: list, mcpServersLoaded: true })
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
        await saveMcpServersToDisk(next)
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.saveMcpServer',
          message: `Failed to persist MCP registry (${String(err)})`
        })
        throw err
      }
    }),

  importMcpServers: async (servers) => {
    if (servers.length === 0) return
    await runSerializedMcpRegistryMutation(async () => {
      const list = get().mcpServers
      const next = [...list, ...servers]
      set({ mcpServers: next })
      try {
        await saveMcpServersToDisk(next)
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
        await saveMcpServersToDisk(next)
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
        await saveMcpServersToDisk(next)
      } catch (err) {
        set({ mcpServers: list })
        void logFrontendError({
          source: 'acp-store.deleteMcpServer',
          message: `Failed to persist MCP registry deletion (${String(err)})`
        })
        throw err
      }
    }),

  // CAP-7: on a desktop host-level project switch, mirror the app-store MCP
  // registry to the new project's `.termul/mcp-servers.json` so the web
  // `GET /mcp-servers` route (file-based) serves the same registry. Invoked
  // from `useProjectsAutoSave` AFTER `syncProjects` lands so the backend
  // `ProjectRegistry` (and thus the resolved project root) reflects the new
  // default. Best-effort + non-fatal — the wrapper logs failures and never
  // throws, so a switch still completes even if the sync write fails.
  syncMcpRegistryToProjectFile: async () => {
    if (!isTauriContext()) return
    if (!get().mcpServersLoaded) return
    await syncMcpRegistryToProjectBestEffort(get().mcpServers)
  },

  // MCP probe (on-demand, read-only). No persistence, no rollback. Dedupes
  // concurrent probes per server id via `mcpProbing`.
  probeMcpServer: async (id) => {
    if (get().mcpProbing[id]) return
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    // Strip registry-only fields (`id`/`enabled`) — the probe takes a
    // stateless `McpServerConfig`, not a registry entry. Mirrors the wire
    // shape `toWireServer` builds for `session/new` injection.
    const { id: _id, enabled: _enabled, ...config } = server
    set((s) => ({ mcpProbing: { ...s.mcpProbing, [id]: true } }))
    try {
      const result: ProbeResult = await acpApi.probeMcpServer(config as McpServerConfig)
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
      void logFrontendError({
        source: 'acp-store.probeMcpServer',
        message: `MCP probe failed for server '${server.name}' (${String(err)})`
      })
    }
  },

  loadMcpTools: async (id) => {
    // Auto-probe on first expand — no-op if already loaded (or in flight).
    if (get().mcpToolsLoaded[id] || get().mcpProbing[id]) return
    await get().probeMcpServer(id)
  },
  connectMcpOAuth: async (id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    set((s) => ({ mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: true } }))
    void logFrontendError({
      source: 'acp-store.connectMcpOAuth',
      message: `OAuth flow started for server '${server.name}'`
    })
    try {
      await acpApi.startMcpOAuth(url)
      // startMcpOAuth now blocks until the token is stored (desktop: the
      // Tauri command blocks; web: polls the status endpoint). Setting
      // connected state here is correct — the token is confirmed.
      set((s) => ({
        mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: true },
        mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: false }
      }))
      void logFrontendError({
        source: 'acp-store.connectMcpOAuth',
        message: `OAuth token confirmed for server '${server.name}'`
      })
      // Re-probe now that we have a token — should succeed.
      await get().probeMcpServer(id)
    } catch (err) {
      set((s) => ({ mcpOAuthConnecting: { ...s.mcpOAuthConnecting, [id]: false } }))
      void logFrontendError({
        source: 'acp-store.connectMcpOAuth',
        message: `OAuth flow failed for server '${server.name}' (${String(err)})`
      })
      throw err
    }
  },

  checkMcpOAuthStatus: async (id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    try {
      const hasToken = await acpApi.hasMcpOAuthToken(url)
      set((s) => ({ mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: hasToken } }))
    } catch {
      // Best-effort — the probe will still detect authRequired.
    }
  },

  disconnectMcpOAuth: async (id) => {
    const server = get().mcpServers.find((s) => s.id === id)
    if (!server) return
    const url = (server as Extract<StoredMcpServer, { type: 'http' | 'sse' }>).url
    if (!url) return
    try {
      await acpApi.disconnectMcpOAuth(url)
      set((s) => ({ mcpOAuthConnected: { ...s.mcpOAuthConnected, [id]: false } }))
      void logFrontendError({
        source: 'acp-store.disconnectMcpOAuth',
        message: `OAuth disconnect completed for server '${server.name}'`
      })
      // Re-probe — should return authRequired again.
      await get().probeMcpServer(id)
    } catch (err) {
      void logFrontendError({
        source: 'acp-store.disconnectMcpOAuth',
        message: `OAuth disconnect failed for server '${server.name}' (${String(err)})`
      })
      throw err
    }
  }
})
