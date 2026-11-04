/**
 * Renderer facade for the host's `chat_activity` watch. Every carrier speaks
 * `/ws` (the desktop over its IPC Channel), so one client serves the desktop,
 * a shared-live phone and a `termul-server` browser alike.
 */
import type {
  ChatActivityWatchDelta,
  ChatActivityWatchState
} from '@shared/types/web-protocol.types'
import { type AcpTransport, getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { useChatActivityStore } from '@/stores/chat-activity-store'

const SOURCE = 'chat-activity-sync'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Start mirroring the host's chat activity. Returns the stop. */
export function startChatActivitySync(transport: AcpTransport = getAcpTransport()): () => void {
  const store = useChatActivityStore.getState
  const stop = transport.watches?.subscribe<ChatActivityWatchState, ChatActivityWatchDelta>(
    'chat_activity',
    {
      onState: (state) => {
        const sessions = state?.sessions ?? {}
        store().replace(sessions)
        void logFrontendError({
          level: 'info',
          source: SOURCE,
          message: `chat activity state received for ${Object.keys(sessions).length} chats`
        })
      },
      onDelta: (delta) => {
        if (delta?.sessionId) store().apply(delta)
      },
      onRefused: (error) => {
        void logFrontendError({
          level: 'warn',
          source: SOURCE,
          message: `chat_activity watch refused; chat lists show no host status: ${describe(error)}`
        })
      }
    }
  )
  if (!stop) {
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: 'transport has no watches; chat lists show no host status'
    })
  }
  return () => stop?.()
}
