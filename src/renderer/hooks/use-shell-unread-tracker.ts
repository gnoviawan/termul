import { useEffect, useLayoutEffect } from 'react'
import { useShallow } from 'zustand/shallow'
import { useChatReadMarker } from '@/hooks/use-chat-read-marker'
import { resolveMobileActiveLeaf } from '@/hooks/use-mobile-active-leaf'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { startChatActivitySync } from '@/lib/chat-activity-sync'
import { useChatActivityStore } from '@/stores/chat-activity-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, PaneNode } from '@/types/workspace.types'

function activeChatSessionId(leaf: LeafNode): string | null {
  const tab = leaf.tabs.find((t) => t.id === leaf.activeTabId)
  return tab?.type === 'agent-chat' ? tab.sessionId : null
}

/**
 * Session ids of the agent chats currently shown: every leaf's active tab when
 * it is an agent chat on desktop, or only the mobile active leaf's on the mobile
 * web shell (which renders a single leaf).
 */
export function activeChatSessionIds(
  root: PaneNode,
  activePaneId: string | null | undefined,
  mobile: boolean
): string[] {
  const leaves = mobile
    ? [resolveMobileActiveLeaf(root, activePaneId).leaf].filter(
        (leaf): leaf is LeafNode => leaf !== null
      )
    : getAllLeafPanes(root)
  const ids: string[] = []
  for (const leaf of leaves) {
    const id = activeChatSessionId(leaf)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * The one per-renderer mount of the host's chat activity: it mirrors the
 * `chat_activity` watch every chat list reads, tells the store which chats this
 * renderer shows (their "New activity" dot stays hidden here), and reports
 * those chats read so the dot clears on every surface. Called from
 * `WorkspaceLayout`, which serves both `TauriApp.tsx` and `App.tsx`.
 */
export function useShellUnreadTracker(): void {
  const mobile = useMobileWebShell()
  const activeSessionIds = useWorkspaceStore(
    useShallow((state) => activeChatSessionIds(state.root, state.activePaneId, mobile))
  )
  useEffect(() => startChatActivitySync(), [])
  const activeKey = activeSessionIds.join('\u0000')
  // Before paint: a chat switched to must not show its own dot for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey is the stable identity of activeSessionIds
  useLayoutEffect(() => {
    useChatActivityStore.getState().setViewing(activeSessionIds)
  }, [activeKey])
  useChatReadMarker(activeSessionIds)
}
