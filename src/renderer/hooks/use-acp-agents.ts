import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect } from 'react'
import {
  pickDefaultSupportedAgent,
  resolveSupportedAcpAgents
} from '@/lib/agents/supported-acp-agents'
import { persistenceApi } from '@/lib/api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * Load persisted ACP agent configs once at app mount, then resolve the
 * last-selected ready supported ACP agent (falling back to the default ready
 * entry) and publish it as the warm-pool target. The hook prewarms that agent's
 * process and seeds its warm-session pool for the active project cwd; re-runs on
 * project switch. Agent Chat derives supported configs automatically, so prewarm
 * must not fan out across every supported agent or depend on Preferences toggles.
 */
export function useAcpAgents(): void {
  const loadAgentConfigs = useAcpStore((s) => s.loadAgentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  const setSelectedAgentConfigId = useAcpStore((s) => s.setSelectedAgentConfigId)
  const retargetWarmPool = useAcpStore((s) => s.retargetWarmPool)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await loadAgentConfigs()
      if (cancelled) return
      const { agentConfigs, prewarmAgent } = useAcpStore.getState()
      const cwd = activeProjectId ? getDefaultCwdForProject(activeProjectId) : ''
      if (cwd.trim().length === 0) {
        setSelectedAgentConfigId(null)
        return
      }
      const supportedAgents = await resolveSupportedAcpAgents(agentConfigs)
      const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
      if (cancelled) return
      const saved = persisted.success ? (persisted.data as Partial<LastSelectedAgent> | null) : null
      const selected =
        saved?.mode === 'acp' && typeof saved.agentId === 'string'
          ? supportedAgents.find(
              (entry) => entry.configId === saved.agentId && entry.status === 'ready'
            )
          : null
      const entry = selected ?? pickDefaultSupportedAgent(supportedAgents)
      if (!entry?.config) {
        setSelectedAgentConfigId(null)
        return
      }
      if (!agentConfigs.some((config) => config.id === entry.config?.id)) {
        await saveAgentConfig(entry.config)
        if (cancelled) return
      }
      // `activeProjectId` is a dep, so a project switch re-runs this effect
      // and flips `cancelled` on the previous (in-flight) run via its cleanup.
      // Guard every await boundary so only the latest run reaches prewarmAgent.
      if (cancelled) return
      setSelectedAgentConfigId(entry.config.id)
      void prewarmAgent(entry.config.id, cwd)
      void retargetWarmPool(entry.config.id, cwd, activeProjectId)
    })()
    return () => {
      cancelled = true
    }
  }, [
    loadAgentConfigs,
    saveAgentConfig,
    setSelectedAgentConfigId,
    retargetWarmPool,
    activeProjectId
  ])
}
