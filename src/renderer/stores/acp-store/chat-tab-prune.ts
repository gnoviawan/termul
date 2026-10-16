/**
 * Index-load corpse prune of restored agent-chat tabs (#903). Runs after the
 * session index lands, over EVERY project's tree (active and parked): a tab
 * whose session is neither live nor indexed could only render the "chat
 * unavailable" fallback. Chat sessions keep running; no PTY is touched.
 *
 * Ownership is not consulted: a chat tab in a project's tree is the tab that
 * project's restore or user put there.
 */

import { getAllLeafPanes, getAllTreeRoots, useWorkspaceStore } from '@/stores/workspace-store'

interface PruneRestoredChatTabsInput {
  liveSessionIds: ReadonlySet<string>
  indexedSessionIds: ReadonlySet<string>
}

export function pruneRestoredChatTabs(input: PruneRestoredChatTabsInput): void {
  const { liveSessionIds, indexedSessionIds } = input
  const workspace = useWorkspaceStore.getState()
  const corpseTabIds: string[] = []
  for (const root of getAllTreeRoots(workspace)) {
    for (const pane of getAllLeafPanes(root)) {
      for (const tab of pane.tabs) {
        if (tab.type !== 'agent-chat') continue
        if (!liveSessionIds.has(tab.sessionId) && !indexedSessionIds.has(tab.sessionId)) {
          corpseTabIds.push(tab.id)
        }
      }
    }
  }
  // Removal reshapes the trees, so it runs after the scan; `removeTab` finds a
  // tab in the visible tree first, then in any parked tree.
  for (const tabId of corpseTabIds) useWorkspaceStore.getState().removeTab(tabId)
}
