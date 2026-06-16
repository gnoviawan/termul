import type { LastSelectedAgent } from '@shared/types/persistence.types'
import { PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect } from 'react'
import { currentPlatformArch } from '@/lib/agents/acp-registry'
import { buildSupportedAcpAgents } from '@/lib/agents/supported-acp-agents'
import { persistenceApi } from '@/lib/api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * Load persisted ACP agent configs once at app mount, then warm only the
 * last-selected ready supported ACP agent, falling back to the default ready
 * entry. Agent Chat derives supported configs automatically, so prewarm must not
 * fan out across every supported agent or depend on Preferences toggles.
 */
export function useAcpAgents(): void {
  const loadAgentConfigs = useAcpStore((s) => s.loadAgentConfigs)
  const saveAgentConfig = useAcpStore((s) => s.saveAgentConfig)
  useEffect(() => {
    void (async () => {
      await loadAgentConfigs()
      const { agentConfigs, prewarmAgent } = useAcpStore.getState()
      const activeProjectId = useProjectStore.getState().activeProjectId
      const cwd = activeProjectId ? getDefaultCwdForProject(activeProjectId) : ''
      if (cwd.trim().length === 0) return
      const supportedAgents = buildSupportedAcpAgents(agentConfigs, currentPlatformArch())
      const persisted = await persistenceApi.read<unknown>(PersistenceKeys.lastSelectedAgent)
      const saved = persisted.success ? (persisted.data as Partial<LastSelectedAgent> | null) : null
      const selected =
        saved?.mode === 'acp' && typeof saved.agentId === 'string'
          ? supportedAgents.find(
              (entry) => entry.configId === saved.agentId && entry.status === 'ready'
            )
          : null
      const entry = selected ?? supportedAgents.find((candidate) => candidate.status === 'ready')
      if (!entry?.config) return
      if (!agentConfigs.some((config) => config.id === entry.config?.id)) {
        await saveAgentConfig(entry.config)
      }
      void prewarmAgent(entry.config.id, cwd)
    })()
  }, [loadAgentConfigs, saveAgentConfig])
}
