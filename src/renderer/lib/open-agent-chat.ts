import { isMobileWebShellViewport } from '@/hooks/use-mobile-web-shell'
import { sessionOwnerProjectId } from '@/lib/acp-session-ownership'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { useSSHStore } from '@/stores/ssh-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * Bring an Agent chat on screen IN ITS OWN PROJECT. The pane tree is shared
 * across projects, so adding another project's chat tab directly would leak
 * it into the active project's workspace. A chat owned by another project
 * switches to that project first (the sidebar "needs you" pattern): the chat
 * is retained + one-shot focused for the owner, and the workspace restore
 * reattaches and activates it. Unknown ownership opens in place (fail-open).
 */
export function openAgentChatInOwnProject(sessionId: string, source: string): void {
  const acp = useAcpStore.getState()
  const owner = sessionOwnerProjectId(sessionId, acp)
  const activeProjectId = useProjectStore.getState().activeProjectId
  if (!owner || owner === activeProjectId) {
    useWorkspaceStore.getState().addAgentChatTab(sessionId)
    return
  }
  const lifetime = useAgentChatLifetimeStore.getState()
  lifetime.retainProjectChats(owner, [sessionId])
  lifetime.requestFocus(owner, sessionId)
  void logFrontendError({
    level: 'info',
    source,
    message: `Opening chat ${sessionId} switches project ${activeProjectId} -> ${owner}`
  })
  if (isMobileWebShellViewport()) {
    // The phone shell switches through the shared server session (parity
    // with its project sheet); it selects the project locally on success.
    void acp.switchProject(owner).catch((error: unknown) => {
      acp.setFailedProjectSwitch(owner)
      void logFrontendError({
        level: 'warn',
        source,
        message: `Project switch to ${owner} for chat ${sessionId} failed: ${String(error)}`
      })
    })
    return
  }
  // Desktop / desktop-style web: same as the sidebar's project select.
  useProjectStore.getState().selectProject(owner)
  useSSHStore.getState().selectProfile(null)
}
