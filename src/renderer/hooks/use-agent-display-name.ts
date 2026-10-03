import { configIdFromReuseKey } from '@/stores/acp-reuse-keys'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Live `agentId` → configured display name. Consent/auth events carry the
 * live agent id, not the config id, so reverse it through `configToLiveAgent`
 * and look up `agentConfigs` — the same resolution `BrowserAuthDialogHost`
 * inlines for `pendingBrowserOpen`. Returns undefined when the live id is
 * unmapped or the config list hasn't loaded; callers fall back to "the agent".
 */
export function useAgentDisplayName(agentId: string | undefined): string | undefined {
  return useAcpStore((s) => {
    if (!agentId) return undefined
    const reuseKey = Object.keys(s.configToLiveAgent).find(
      (k) => s.configToLiveAgent[k] === agentId
    )
    const configId = reuseKey ? configIdFromReuseKey(reuseKey) : null
    return s.agentConfigs.find((c) => c.id === configId)?.name
  })
}
