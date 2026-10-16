import { toast } from 'sonner'
import { useAcpStore } from '@/stores/acp-store'
import { reloadAgentChat, reloadChatBlockedReason } from '@/stores/reload-chat'

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
      void reloadAgentChat(sessionId).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Could not reload this chat.')
      })
    },
    disabled: reason !== null || reloading,
    reason,
    reloading
  }
}
