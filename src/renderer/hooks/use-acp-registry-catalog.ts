import { useCallback, useEffect, useState } from 'react'
import { acpApi } from '@/lib/acp-api'
import {
  compareRegistryVersions,
  normalizeRegistrySnapshot,
  REGISTRY_AGENTS,
  type RegistryAgent
} from '@/lib/agents/acp-registry'
import { mergeAppOwnedAcpAgents } from '@/lib/agents/antigravity-acp'

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
const listeners = new Set<() => void>()
const BUNDLED_ACTIVE_REGISTRY = mergeAppOwnedAcpAgents(REGISTRY_AGENTS)

/** Active registry for non-React callers (e.g. mount-time prewarm). Returns the
 * bundled catalog unless the user has explicitly applied a fetched remote
 * snapshot, so remote `distribution` data stays advisory until promoted. */
export function getActiveAcpRegistry(): readonly RegistryAgent[] {
  return sharedActiveRemote && sharedAdvisoryAgents
    ? mergeAppOwnedAcpAgents(sharedAdvisoryAgents)
    : BUNDLED_ACTIVE_REGISTRY
}

function notifyRegistryCatalogListeners(): void {
  for (const listener of listeners) listener()
}

export function useAcpRegistryCatalog(): {
  activeRegistry: readonly RegistryAgent[]
  usingRemoteRegistry: boolean
  remoteAvailable: boolean
  advisorySummary: RegistryUpdateSummary | null
  checking: boolean
  lastCheckedAt: string | null
  checkForUpdates: (forceRefresh?: boolean) => Promise<RegistryUpdateSummary | null>
  applyRemoteRegistry: () => void
  useBundledRegistry: () => void
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

  const checkForUpdates = useCallback(async (forceRefresh = true) => {
    setChecking(true)
    try {
      const snapshot = await acpApi.fetchRegistrySnapshot(forceRefresh)
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

  const applyRemoteRegistry = useCallback(() => {
    if (!sharedAdvisoryAgents) return
    sharedActiveRemote = true
    notifyRegistryCatalogListeners()
  }, [])

  const useBundledRegistry = useCallback(() => {
    sharedAdvisoryAgents = null
    sharedAdvisorySummary = null
    sharedActiveRemote = false
    sharedLastCheckedAt = null
    notifyRegistryCatalogListeners()
  }, [])

  return {
    activeRegistry: getActiveAcpRegistry(),
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
