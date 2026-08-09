import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * Null-rendering component that triggers `openHistorySession` when the URL
 * contains `#/c/<sessionId>`. This is the refresh-survival mechanism for the
 * active chat — on reload the session restores from the URL before the
 * workspace manifest or session index loads, avoiding the "no active chat"
 * race.
 *
 * Retries up to 5 times with a 500ms delay because the server's history
 * persistence is async — a session that was just active may not be in the
 * persisted store immediately after a refresh.
 *
 * After restoring, calls `addAgentChatTab` to ensure the session has a
 * visible tab in the workspace (the manifest may not have restored it).
 */
export function ChatRoute(): null {
  const location = useLocation()
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const sessionIndex = useAcpStore((s) => s.sessionIndex)

  const sessionId = useMemo(() => {
    const match = location.pathname.match(/^\/c\/(.+)$/)
    return match?.[1] ?? null
  }, [location.pathname])

  useEffect(() => {
    if (!sessionId) return
    const existing = useAcpStore.getState().sessions[sessionId]
    if (existing && existing.status !== 'closed') {
      useWorkspaceStore.getState().addAgentChatTab(sessionId)
      return
    }
    let cancelled = false
    let attempt = 0
    const maxAttempts = 5
    const tryOpen = async (): Promise<void> => {
      if (cancelled) return
      attempt++
      try {
        await openHistorySession(sessionId)
        if (!cancelled) {
          useWorkspaceStore.getState().addAgentChatTab(sessionId)
        }
      } catch {
        if (cancelled || attempt >= maxAttempts) return
        setTimeout(tryOpen, 500)
      }
    }
    void tryOpen()
    return () => {
      cancelled = true
    }
  }, [sessionId, openHistorySession])

  return null
}
