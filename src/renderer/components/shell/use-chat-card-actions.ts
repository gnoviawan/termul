import { useCallback } from 'react'
import { toast } from 'sonner'
import type { ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const LOG_SOURCE = 'shell-chats-list'

export interface ChatCardActions {
  onOpen: (entry: ProjectChatEntry) => void
}

/**
 * Opens or resumes a chat card's chat in a tab (the Rail rows and the command
 * palette Chats group), with one warn log per failed open.
 */
export function useChatCardActions(): ChatCardActions {
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)

  const onOpen = useCallback(
    (entry: ProjectChatEntry) => {
      const fail = (error: unknown): void => {
        // Never the chat title or any prompt text: the error message only.
        const reason = error instanceof Error ? error.message : 'unknown error'
        void logFrontendError({
          level: 'warn',
          source: LOG_SOURCE,
          message: `[shell-chats] open chat failed: ${reason}`
        })
        toast.error('Could not open that chat. Try again.')
      }
      try {
        const opening = openHistorySession(entry.id)
        addAgentChatTab(entry.id)
        void opening.catch(fail)
      } catch (error) {
        fail(error)
      }
    },
    [addAgentChatTab, openHistorySession]
  )

  return { onOpen }
}
