import { logFrontendError } from '@/lib/log-api'
import {
  isLaunchPlaceholderSessionId,
  isLiveLaunchSession,
  noteDroppedLaunchPlaceholders,
  partitionRestoredAgentChatIds
} from '@/stores/acp-store/live-turn'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { findPaneById, getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
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
  for (const leaf of getAllLeafPanes(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'agent-chat') continue
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
  const { placeholders, sessionIds: restoredIds } = partitionRestoredAgentChatIds(
    collectAgentChatSessionIds(layout)
  )
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
  const sessionIds = useAgentChatLifetimeStore.getState().retainedByProject[projectId] ?? []
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
