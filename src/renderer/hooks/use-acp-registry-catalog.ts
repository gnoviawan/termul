import { useCallback, useEffect, useState } from 'react'
import { acpApi } from '@/lib/acp-api'
import {
  compareRegistryVersions,
  normalizeRegistrySnapshot,
  REGISTRY_AGENTS,
  type RegistryAgent
} from '@/lib/agents/acp-registry'
import { acpCatalogApi } from '@/lib/api'

export interface RegistryUpdateSummary {
  updatedCount: number
  newAgentIds: string[]
  fetchedAt: string | null
  source: string
}

// Remote registry state is split into two layers so unsigned CDN
// `distribution` metadata can never auto-replace the trusted bundled catalog:
//   - `sharedAdvisoryAgents`: the fetched remote snapshot, kept for diff /
//     "updates available" display only. It is NOT consumed by launch flows.
//   - `sharedActiveRemote`: an explicit user opt-in that promotes the advisory
//     snapshot into `getActiveAcpRegistry()` so `AgentLauncher` can use it.
// A compromised registry origin therefore cannot redirect executable downloads
// until the user explicitly applies the remote registry from Settings.
let sharedAdvisoryAgents: RegistryAgent[] | null = null
let sharedActiveRemote = false
let sharedAdvisorySummary: RegistryUpdateSummary | null = null
let sharedLastCheckedAt: string | null = null
let advisoryEpoch = 0
let optInEpoch = 0
const listeners = new Set<() => void>()

/** Latest fetched remote snapshot. Empty before the first check. */
export function getAdvisoryAcpRegistry(): readonly RegistryAgent[] {
  return sharedAdvisoryAgents ?? []
}

/** Active registry for non-React callers (e.g. mount-time prewarm). Returns the
 * bundled catalog unless the user has explicitly applied a fetched remote
 * snapshot, so remote `distribution` data stays advisory until promoted. */
export function getActiveAcpRegistry(): readonly RegistryAgent[] {
  return sharedActiveRemote && sharedAdvisoryAgents ? sharedAdvisoryAgents : REGISTRY_AGENTS
}

function notifyRegistryCatalogListeners(): void {
  for (const listener of listeners) listener()
}

export function useAcpRegistryCatalog(): {
  activeRegistry: readonly RegistryAgent[]
  /** The latest fetched Remote Snapshot (advisory; empty before the first check). */
  remoteRegistry: readonly RegistryAgent[]
  usingRemoteRegistry: boolean
  remoteAvailable: boolean
  advisorySummary: RegistryUpdateSummary | null
  checking: boolean
  lastCheckedAt: string | null
  checkForUpdates: (forceRefresh?: boolean) => Promise<RegistryUpdateSummary | null>
  applyRemoteRegistry: () => Promise<void>
  useBundledRegistry: () => Promise<void>
} {
  const [, bump] = useState(0)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const listener = () => bump((value) => value + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const advisoryAtStart = advisoryEpoch
    const optInAtStart = optInEpoch
    void (async () => {
      const result = await acpCatalogApi.isCatalogOptedIn()
      if (cancelled || !result.success || result.data !== true) return
      try {
        const listed = await acpCatalogApi.listCatalog(false)
        if (cancelled || !listed.success || listed.data.registryDegraded) return
        const confirmed = await acpCatalogApi.isCatalogOptedIn()
        if (
          cancelled ||
          optInAtStart !== optInEpoch ||
          !confirmed.success ||
          confirmed.data !== true
        ) {
          return
        }
        const normalized = normalizeRegistrySnapshot(listed.data.agents)
        if (normalized.length === 0) return
        if (advisoryAtStart === advisoryEpoch) {
          sharedAdvisoryAgents = normalized
          sharedAdvisorySummary = {
            ...compareRegistryVersions(REGISTRY_AGENTS, normalized),
            fetchedAt: null,
            source: 'registry'
          }
          sharedLastCheckedAt = new Date().toISOString()
        }
        sharedActiveRemote = true
        notifyRegistryCatalogListeners()
      } catch {
        // Keep the renderer on the bundled catalog until a snapshot exists.
        // The host opt-in flag stays set.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const checkForUpdates = useCallback(async (forceRefresh = true) => {
    const advisoryAtStart = ++advisoryEpoch
    setChecking(true)
    try {
      const snapshot = await acpApi.fetchRegistrySnapshot(forceRefresh)
      if (advisoryAtStart !== advisoryEpoch) return null
      const normalized = normalizeRegistrySnapshot(snapshot.agents)
      if (normalized.length === 0) return null
      const summary: RegistryUpdateSummary = {
        ...compareRegistryVersions(REGISTRY_AGENTS, normalized),
        fetchedAt: snapshot.fetchedAt ?? null,
        source: snapshot.source
      }
      // Advisory only: store the remote snapshot for diff/display, but do NOT
      // promote it to the active registry. Promotion requires an explicit
      // `applyRemoteRegistry()` call from the Settings UI.
      sharedAdvisoryAgents = normalized
      sharedAdvisorySummary = summary
      sharedLastCheckedAt = snapshot.fetchedAt ?? null
      notifyRegistryCatalogListeners()
      return summary
    } finally {
      setChecking(false)
    }
  }, [])

  const applyRemoteRegistry = useCallback(
    async () => {
      if (!sharedAdvisoryAgents) {
        // Throw (do NOT silently return): a silent return would let the caller's
        // UI flip to a "using remote registry" state the host never opted into
        // (UI/host split-brain). The Settings caller wraps this in a try/catch
        // that surfaces the error as a toast, so the user is told to check for
        // updates before applying.
        throw new Error(
          'No remote registry snapshot has been fetched. Check for updates before applying.'
        )
      }
      // CAP-6 / Story 8: the opt-in is now host-persisted. The renderer's
      // `applyRemoteRegistry()` becomes a call to `setCatalogOptIn(true)` so
      // the host gates CDN augmentation (the host enforces "trusted or
      // explicitly approved" before serving). The persisted state moves
      // host-side. Surface a rejection (e.g. degraded mode) as a throw so the
      // caller's UI does not flip local state to a success the host never
      // persisted (UI/host split-brain).
      const result = await acpCatalogApi.setCatalogOptIn(true)
      if (!result.success) {
        throw new Error(result.error ?? result.code ?? 'Could not apply the remote registry.')
      }
      optInEpoch += 1
      sharedActiveRemote = true
      notifyRegistryCatalogListeners()
    },
    [
      /* deps */
    ]
  )

  const useBundledRegistry = useCallback(
    async () => {
      // CAP-6 / Story 8: clear the host-persisted opt-in so the next catalog
      // resolution excludes CDN entries. Surface a rejection as a throw so the
      // caller does not clear local state the host kept opted-in.
      const result = await acpCatalogApi.setCatalogOptIn(false)
      if (!result.success) {
        throw new Error(result.error ?? result.code ?? 'Could not switch to the bundled registry.')
      }
      optInEpoch += 1
      sharedAdvisoryAgents = null
      sharedAdvisorySummary = null
      sharedActiveRemote = false
      sharedLastCheckedAt = null
      notifyRegistryCatalogListeners()
    },
    [
      /* deps */
    ]
  )

  return {
    activeRegistry: getActiveAcpRegistry(),
    remoteRegistry: sharedAdvisoryAgents ?? [],
    usingRemoteRegistry: sharedActiveRemote,
    remoteAvailable: sharedAdvisoryAgents !== null && !sharedActiveRemote,
    advisorySummary: sharedAdvisorySummary,
    checking,
    lastCheckedAt: sharedLastCheckedAt,
    checkForUpdates,
    applyRemoteRegistry,
    useBundledRegistry
  }
}
