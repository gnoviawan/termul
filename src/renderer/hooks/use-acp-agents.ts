import { useEffect } from 'react'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load persisted ACP agent configs once at app mount. Mirrors the other
 * mount-time loader hooks (e.g. use-app-settings).
 */
export function useAcpAgents(): void {
  const loadAgentConfigs = useAcpStore((s) => s.loadAgentConfigs)
  useEffect(() => {
    void loadAgentConfigs()
  }, [loadAgentConfigs])
}
