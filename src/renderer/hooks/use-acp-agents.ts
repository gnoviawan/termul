import { useEffect } from 'react'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Load persisted ACP agent configs once at app mount, then warm them up in the
 * background. Mirrors the other mount-time loader hooks (e.g. use-app-settings).
 *
 * Every entry in `agentConfigs` is an enabled agent: enabling an agent persists
 * its config and disabling it deletes the config (there is no separate `enabled`
 * flag). So warming the whole list warms exactly the agents the Settings toggle
 * would warm — here we do it on launch too, not only on first toggle.
 *
 * Pre-warming means an enabled agent has its process spawned and `initialize`
 * handshake done before the user opens a chat, so `startChat` reuses a warm
 * agent instead of paying the cold spawn cost on the send critical path.
 * `prewarmAgent` is best-effort, deduped, and silent on failure — chat still
 * lazy-spawns if warm-up didn't run. The fan-out is bounded by the number of
 * enabled agents (typically 1–3).
 */
export function useAcpAgents(): void {
  const loadAgentConfigs = useAcpStore((s) => s.loadAgentConfigs)
  useEffect(() => {
    void (async () => {
      await loadAgentConfigs()
      const { agentConfigs, prewarmAgent } = useAcpStore.getState()
      for (const config of agentConfigs) {
        void prewarmAgent(config.id)
      }
    })()
  }, [loadAgentConfigs])
}
