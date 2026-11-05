import { useEffect, useSyncExternalStore } from 'react'
import { markChatRead } from '@/lib/chat-read-sync'
import { useChatActivityStore } from '@/stores/chat-activity-store'

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
 * Reports every shown chat the host calls unread as read up to its newest turn
 * end, so its "New activity" dot clears on every surface. A hidden or
 * unfocused page (a backgrounded phone tab, a desktop window behind another
 * app) reads nothing, so a surface left on a chat does not clear the dot the
 * user is watching elsewhere. `activeSessionIds` is the chats this renderer
 * shows (`activeChatSessionIds`).
 */
export function useChatReadMarker(activeSessionIds: readonly string[]): void {
  const attended = useSyncExternalStore(subscribeAttention, pageAttended)
  const sessions = useChatActivityStore((state) => state.sessions)

  useEffect(() => {
    if (!attended) return
    for (const sessionId of activeSessionIds) {
      const record = sessions[sessionId]
      if (record?.unread && record.turnEnd) markChatRead(sessionId, record.turnEnd)
    }
  }, [activeSessionIds, attended, sessions])
}
