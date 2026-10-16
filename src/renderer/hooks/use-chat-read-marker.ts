import { useEffect, useSyncExternalStore } from 'react'
import { markChatRead } from '@/lib/chat-read-sync'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'

function subscribeAttention(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
}

function pageAttended(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Reports every shown chat as read on the host, so the dot it banked on other
 * surfaces clears: on becoming shown, and on each turn end while shown. A
 * hidden or unfocused page (a backgrounded phone tab, a desktop window behind
 * another app) reads nothing, so a surface left on a chat does not clear the
 * dot the user is watching elsewhere. `activeSessionIds` is the chats this
 * renderer shows (`activeChatSessionIds`).
 */
export function useChatReadMarker(activeSessionIds: readonly string[]): void {
  const attended = useSyncExternalStore(subscribeAttention, pageAttended)
  const seenTurnEndSeq = useAgentChatUnreadStore((state) => state.seenTurnEndSeq)
  const sharedReadSeq = useAgentChatUnreadStore((state) => state.sharedReadSeq)

  useEffect(() => {
    if (!attended) return
    for (const sessionId of activeSessionIds) {
      const seq = seenTurnEndSeq[sessionId]
      if (seq !== undefined && seq > (sharedReadSeq[sessionId] ?? 0)) markChatRead(sessionId, seq)
    }
  }, [activeSessionIds, attended, seenTurnEndSeq, sharedReadSeq])
}
