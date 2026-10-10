import { logFrontendError } from '@/lib/log-api'
import {
  isLaunchPlaceholderSessionId,
  isLiveLaunchSession,
  noteDroppedLaunchPlaceholders,
  partitionRestoredAgentChatIds
} from '@/stores/acp-store/live-turn'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { findPaneById, getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import { chatForeignToProject } from './pane-tree'
import type { PersistedPaneNodeInput } from './types'

function collectAgentChatSessionIds(node: PersistedPaneNodeInput | undefined): string[] {
  if (!node || 'editorFilePaths' in node) return []
  if (node.type === 'leaf') {
    return node.tabs.flatMap((tab) => (tab.type === 'agent-chat' ? [tab.sessionId] : []))
  }
  return node.children.flatMap((child) => collectAgentChatSessionIds(child))
}

export function retainVisibleAgentChats(projectId: string): void {
  if (!projectId) return
  const { root, activePaneId } = useWorkspaceStore.getState()
  const sessionIds: string[] = []
  let activeSessionId: string | null = null
  const activePane = findPaneById(root, activePaneId)
  // Project ownership filter: the workspace pane tree is global, so tabs
  // from OTHER projects can be present when the switch happens (a retained
  // chat kept mounted cross-project). Retaining them here would MERGE those
  // foreign sessions into this project's retained set (the retention store
  // unions, never replaces), and reattachOpenAgentChats would re-insert
  // them — accumulating one mixed pile of tabs that makes the switched-to
  // project's workspace look like the layout never changed. Only sessions
  // the acp-store attributes to THIS project belong in its retained set.
  for (const leaf of getAllLeafPanes(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'agent-chat') continue
      if (chatForeignToProject(tab.sessionId, projectId)) continue
      sessionIds.push(tab.sessionId)
      if (activePane?.type === 'leaf' && activePane.id === leaf.id && leaf.activeTabId === tab.id) {
        activeSessionId = tab.sessionId
      }
    }
  }
  const lifetime = useAgentChatLifetimeStore.getState()
  lifetime.retainProjectChats(projectId, sessionIds)
  lifetime.rememberActiveChat(projectId, activeSessionId)
}

export function reattachOpenAgentChats(
  projectId: string,
  layout: PersistedPaneNodeInput | undefined
): void {
  // deserializePaneTree already drops launch-* corpses. Reattach used to
  // read the raw layout and insert them again, which painted "session no
  // longer exists". A launch tab whose ACP session is still live (or still
  // launching) must stay: finalizeChatLaunch remaps that tab. Only dead
  // placeholders are skipped and handed to session recovery.
  // Ownership filter (parity with retainVisibleAgentChats/persistState): a
  // layout saved before the per-project filter landed can still carry OTHER
  // projects' chat tabs; reattaching them verbatim would reintroduce the
  // cross-project tab leak on the next restore. Foreign sessions are dropped
  // here AND from the retained set so they cannot re-enter via retention.
  const { placeholders, sessionIds: restoredIdsAll } = partitionRestoredAgentChatIds(
    collectAgentChatSessionIds(layout)
  )
  const restoredIds = restoredIdsAll.filter(
    (sessionId) => !chatForeignToProject(sessionId, projectId)
  )
  const droppedForeign = restoredIdsAll.length - restoredIds.length
  if (droppedForeign > 0) {
    void logFrontendError({
      level: 'info',
      source: 'useEditorPersistence.reattachOpenAgentChats',
      message: `Dropped ${droppedForeign} foreign-project chat tab(s) from the persisted layout for project ${projectId}`
    })
  }
  const livePlaceholders = placeholders.filter((id) => isLiveLaunchSession(id))
  const deadPlaceholders = placeholders.filter((id) => !isLiveLaunchSession(id))
  if (deadPlaceholders.length > 0) {
    noteDroppedLaunchPlaceholders(projectId, deadPlaceholders)
    void logFrontendError({
      level: 'warn',
      source: 'useEditorPersistence.reattachOpenAgentChats',
      message: `Skipped ${deadPlaceholders.length} failed-launch placeholder tab(s) during chat reattach (${deadPlaceholders.join(', ')})`
    })
  }
  useAgentChatLifetimeStore
    .getState()
    .retainProjectChats(projectId, [...restoredIds, ...livePlaceholders])
  const sessionIds = (
    useAgentChatLifetimeStore.getState().retainedByProject[projectId] ?? []
  ).filter(
    (sessionId) =>
      isLaunchPlaceholderSessionId(sessionId) || !chatForeignToProject(sessionId, projectId)
  )
  for (const sessionId of sessionIds) {
    if (isLaunchPlaceholderSessionId(sessionId) && !isLiveLaunchSession(sessionId)) continue
    useWorkspaceStore.getState().insertAgentChatTab(sessionId)
  }
  const focusId = useAgentChatLifetimeStore.getState().takeFocus(projectId)
  if (
    focusId &&
    sessionIds.includes(focusId) &&
    (!isLaunchPlaceholderSessionId(focusId) || isLiveLaunchSession(focusId))
  ) {
    useWorkspaceStore.getState().addAgentChatTab(focusId)
  }
}
