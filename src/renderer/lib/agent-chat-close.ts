import { logFrontendError } from '@/lib/log-api'
import { markChatClosedOnRoute } from '@/lib/web-tab-session'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'

/**
 * Close an Agent chat tab. The tab goes away immediately; a running turn keeps
 * running in the host, and the host stops the idle agent on its own schedule.
 */
export function closeAgentChat(sessionId: string, closeTab: () => void): void {
  useAgentChatLifetimeStore.getState().releaseChat(sessionId)
  // Route-scoped closed signal: the route (`#/c/<sessionId>`) survives this
  // close, so ChatRoute must not resurrect the chat on a later pane-tree
  // change. Synchronous and independent of acp-store timing (the close may
  // race the mount-time openHistorySession still being in flight).
  markChatClosedOnRoute(sessionId)
  void logFrontendError({
    level: 'info',
    source: 'acp.agentChatClose',
    message: `Closed agent chat ${sessionId}`
  })
  closeTab()
}
