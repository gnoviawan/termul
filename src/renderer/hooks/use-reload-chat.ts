import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import {
  reloadAgentChat,
  reloadChatBlockedReason,
  runningBackgroundAgentCount
} from '@/stores/reload-chat'
import { useReloadConfirmStore } from '@/stores/reload-confirm-store'

/** Reload `sessionId` now, with no confirm. */
export function runReloadChat(sessionId: string): void {
  void reloadAgentChat(sessionId).catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : 'Could not reload this chat.')
  })
}

export function useReloadChat(sessionId: string | null): {
  /** Absent when this surface has no chat to reload. */
  reload: (() => void) | undefined
  disabled: boolean
  /** Shown as the control title while the control is disabled. */
  reason: string | null
  reloading: boolean
} {
  const reason = useAcpStore((s) => (sessionId ? reloadChatBlockedReason(s, sessionId) : null))
  const reloading = useAcpStore((s) =>
    sessionId ? Boolean(s.reloadingChatIds?.[sessionId]) : false
  )
  if (!sessionId) {
    return { reload: undefined, disabled: true, reason: null, reloading: false }
  }
  return {
    reload: () => {
      // A reload stops the old process and its background agents: ask first.
      const backgroundAgents = runningBackgroundAgentCount(useAcpStore.getState(), sessionId)
      if (backgroundAgents > 0) {
        void logFrontendError({
          level: 'info',
          source: 'acp.reloadChat',
          message: `Reload of chat ${sessionId} asks to confirm: ${backgroundAgents} background agents running`
        })
        useReloadConfirmStore.getState().ask({ sessionId, backgroundAgents })
        return
      }
      runReloadChat(sessionId)
    },
    disabled: reason !== null || reloading,
    reason,
    reloading
  }
}
