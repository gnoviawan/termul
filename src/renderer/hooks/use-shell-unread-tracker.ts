import { useEffect } from 'react'
import { useShallow } from 'zustand/shallow'
import { useAgentChatUnreadTracker } from '@/hooks/use-agent-chat-unread-tracker'
import { useChatReadMarker } from '@/hooks/use-chat-read-marker'
import { resolveMobileActiveLeaf } from '@/hooks/use-mobile-active-leaf'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { startChatReadSync } from '@/lib/chat-read-sync'
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
 * The one `useAgentChatUnreadTracker` mount per renderer, with the host's
 * shared last-read markers that clear a dot when the chat is read on another
 * surface. Called from `WorkspaceLayout`, which serves both `TauriApp.tsx` and
 * `App.tsx`.
 */
export function useShellUnreadTracker(): void {
  const mobile = useMobileWebShell()
  const activeSessionIds = useWorkspaceStore(
    useShallow((state) => activeChatSessionIds(state.root, state.activePaneId, mobile))
  )
  useEffect(() => startChatReadSync(), [])
  useAgentChatUnreadTracker(activeSessionIds)
  useChatReadMarker(activeSessionIds)
}
