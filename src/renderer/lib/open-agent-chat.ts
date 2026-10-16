import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import { projectSwitch } from '@/lib/project-switch/coordinator'
import { releaseFocusNotOfProject } from '@/lib/release-stale-focus'
import { sessionProjectId, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { useSSHStore } from '@/stores/ssh-store'
import {
  agentChatTabId,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceStore
} from '@/stores/workspace-store'
import type { DropPosition } from '@/types/workspace.types'

/** Where a chat tab should land: into `paneId` (`center`) or split off its `zone` edge. */
export interface AgentChatPlacement {
  paneId: string
  zone: DropPosition
}

/**
 * `opened`: the tab is on screen in this project. `switched-project`: the chat
 * belongs to another project and the switch was started. `rejected`: a
 * placement was requested for a foreign chat; nothing was changed.
 */
export type OpenAgentChatOutcome = 'opened' | 'switched-project' | 'rejected'

/**
 * Put the chat tab into the requested pane or split. An existing tab moves (no
 * duplicate); a missing target pane falls back to today's open-in-place.
 */
function openAgentChatAtPlacement(sessionId: string, placement: AgentChatPlacement): void {
  const workspace = useWorkspaceStore.getState()
  const target = findPaneById(workspace.root, placement.paneId)
  if (target?.type !== 'leaf') {
    workspace.addAgentChatTab(sessionId)
    return
  }
  // Creates the tab in the target pane, or just activates it where it already is.
  workspace.addAgentChatTab(sessionId, placement.paneId)
  const tabId = agentChatTabId(sessionId)
  const source = findPaneContainingTab(useWorkspaceStore.getState().root, tabId)
  if (!source) return
  const next = useWorkspaceStore.getState()
  if (placement.zone === 'center') {
    next.moveTabToPane(tabId, source.id, placement.paneId)
    return
  }
  // The only tab of a pane cannot be split off that same pane.
  if (source.id === placement.paneId && source.tabs.length < 2) return
  next.moveTabToNewSplit(tabId, source.id, placement.paneId, placement.zone)
}

/**
 * Bring an Agent chat on screen IN ITS OWN PROJECT. Each project has its own
 * pane tree and only the active one is visible, so adding another project's
 * chat tab directly would land it in the wrong workspace. A chat owned by
 * another project switches to that project first (the sidebar "needs you"
 * pattern): the chat is retained + one-shot focused for the owner, and an
 * explicit `open` switch request activates it once the owner's tree is
 * committed. Unknown ownership opens in place (fail-open).
 *
 * With a `placement` the tab lands in that pane or split instead; a chat owned
 * by another project is rejected (no tab, no project switch, no retain).
 */
export function openAgentChatInOwnProject(
  sessionId: string,
  source: string,
  placement?: AgentChatPlacement
): OpenAgentChatOutcome {
  const acp = useAcpStore.getState()
  const owner = sessionProjectId(acp, sessionId)
  const activeProjectId = useProjectStore.getState().activeProjectId
  if (!owner || owner === activeProjectId) {
    if (placement) openAgentChatAtPlacement(sessionId, placement)
    else useWorkspaceStore.getState().addAgentChatTab(sessionId)
    return 'opened'
  }
  if (placement) {
    void logFrontendError({
      level: 'info',
      source,
      message: `Rejected placement of chat ${sessionId}: owned by project ${owner}, active project is ${activeProjectId}`
    })
    return 'rejected'
  }
  const lifetime = useAgentChatLifetimeStore.getState()
  lifetime.retainProjectChats(owner, [sessionId])
  lifetime.requestFocus(owner, sessionId)
  void logFrontendError({
    level: 'info',
    source,
    message: `Opening chat ${sessionId} switches project ${activeProjectId} -> ${owner}`
  })
  // Same as the sidebar's project select (client-only on every surface).
  releaseFocusNotOfProject(owner)
  useProjectStore.getState().selectProject(owner)
  useSSHStore.getState().selectProfile(null)
  // An explicit open (not an effect-driven pick): it survives the pick the
  // workspace hook issues for the same project, and activating the tab is a
  // no-op when the commit's chat reattach already put it on screen.
  void projectSwitch.request({
    kind: 'open',
    projectId: owner,
    afterCommit: () => useWorkspaceStore.getState().addAgentChatTab(sessionId)
  })
  return 'switched-project'
}

/**
 * Place an Agent chat in a pane or split (drag-and-drop, "Open in split"). Only
 * an `opened` outcome loads the session (a closed chat needs it, as a card
 * click does); a foreign chat is rejected with a toast and never resumed.
 */
export function openAgentChatPlaced(
  sessionId: string,
  source: string,
  placement: AgentChatPlacement
): OpenAgentChatOutcome {
  const outcome = openAgentChatInOwnProject(sessionId, source, placement)
  if (outcome === 'rejected') {
    toast.info('That chat belongs to another project.')
    return outcome
  }
  if (outcome === 'opened') {
    const fail = (error: unknown): void => {
      // Never the chat title or any prompt text: the error message only.
      const reason = error instanceof Error ? error.message : 'unknown error'
      void logFrontendError({
        level: 'warn',
        source,
        message: `Open chat ${sessionId} failed: ${reason}`
      })
      toast.error('Could not open that chat. Try again.')
    }
    try {
      void useAcpStore.getState().openHistorySession(sessionId).catch(fail)
    } catch (error) {
      fail(error)
    }
  }
  return outcome
}
