import { useCallback, useEffect, useState } from 'react'
import { acpApi } from '@/lib/acp-api'
import {
  compareRegistryVersions,
  normalizeRegistrySnapshot,
  REGISTRY_AGENTS,
  type RegistryAgent
} from '@/lib/agents/acp-registry'

export interface RegistryUpdateSummary {
  updatedCount: number
  newAgentIds: string[]
  fetchedAt: string | null
  source: string
}

let sharedRemoteAgents: RegistryAgent[] | null = null
let sharedLastCheckedAt: string | null = null
const listeners = new Set<() => void>()

/** Active registry for non-React callers (e.g. mount-time prewarm). */
export function getActiveAcpRegistry(): readonly RegistryAgent[] {
  return sharedRemoteAgents ?? REGISTRY_AGENTS
}

function notifyRegistryCatalogListeners(): void {
  for (const listener of listeners) listener()
}

export function useAcpRegistryCatalog(): {
  activeRegistry: readonly RegistryAgent[]
  usingRemoteRegistry: boolean
  checking: boolean
  lastCheckedAt: string | null
  checkForUpdates: (forceRefresh?: boolean) => Promise<RegistryUpdateSummary | null>
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
      sharedRemoteAgents = normalized
      sharedLastCheckedAt = snapshot.fetchedAt ?? null
      notifyRegistryCatalogListeners()
      return {
        ...compareRegistryVersions(REGISTRY_AGENTS, normalized),
        fetchedAt: snapshot.fetchedAt ?? null,
        source: snapshot.source
      }
    } finally {
      setChecking(false)
    }
  }, [])

  const useBundledRegistry = useCallback(() => {
    sharedRemoteAgents = null
    sharedLastCheckedAt = null
    notifyRegistryCatalogListeners()
  }, [])

  return {
    activeRegistry: getActiveAcpRegistry(),
    usingRemoteRegistry: sharedRemoteAgents !== null,
    checking,
    lastCheckedAt: sharedLastCheckedAt,
    checkForUpdates,
    useBundledRegistry
  }
}
