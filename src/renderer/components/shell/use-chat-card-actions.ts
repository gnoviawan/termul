import { useCallback } from 'react'
import { toast } from 'sonner'
import type { ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import { openerApi } from '@/lib/api'
import { copyChatReference } from '@/lib/chat-reference'
import { copyTextWithToast } from '@/lib/copy-text'
import { logFrontendError } from '@/lib/log-api'
import { openAgentChatPlaced } from '@/lib/open-agent-chat'
import { conversationDeleteIds } from '@/lib/session-chain'
import { openTerminalAtCwd } from '@/lib/terminal-spawn'
import { useAcpStore } from '@/stores/acp-store'
import { liveSwitchSources } from '@/stores/acp-store/shared-state'
import { useWorkspaceStore } from '@/stores/workspace-store'

const LOG_SOURCE = 'shell-chats-list'

function warnFailure(action: 'open' | 'delete', error: unknown): void {
  // Never the chat title or any prompt text: the error message only.
  const reason = error instanceof Error ? error.message : 'unknown error'
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message: `[shell-chats] ${action} chat failed: ${reason}`
  })
}

export interface ChatCardActions {
  onOpen: (entry: ProjectChatEntry) => void
  onOpenInSplit: (entry: ProjectChatEntry) => void
  onDelete: (entry: ProjectChatEntry) => void
  onOpenTerminal: (entry: ProjectChatEntry) => Promise<void>
  onOpenInFileExplorer: (cwd: string) => Promise<void>
  onCopyPath: (cwd: string) => Promise<void>
  onCopyChatId: (entry: ProjectChatEntry) => Promise<void>
  onCopyChatReference: (entry: ProjectChatEntry) => Promise<void>
}

/**
 * Chat card interactions: open or resume a chat, open its terminal or folder,
 * copy its path, id or reference and delete it, plus one warn log per failed open or delete.
 */
export function useChatCardActions(projectId: string): ChatCardActions {
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const deleteHistorySession = useAcpStore((s) => s.deleteHistorySession)
  const addAgentChatTab = useWorkspaceStore((s) => s.addAgentChatTab)

  const onOpen = useCallback(
    (entry: ProjectChatEntry) => {
      const fail = (error: unknown): void => {
        warnFailure('open', error)
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

  const onOpenInSplit = useCallback((entry: ProjectChatEntry) => {
    // Read at call time: the active pane may have changed since render.
    const { activePaneId } = useWorkspaceStore.getState()
    openAgentChatPlaced(entry.id, LOG_SOURCE, { paneId: activePaneId, zone: 'right' })
  }, [])

  // A folded chain row deletes as one conversation. Membership is resolved
  // at click time, not from the rendered `chainIds` snapshot: a switch that
  // completes while the confirm dialog is open extends the chain, and a
  // stale snapshot would leave the newest continuation behind (CodeRabbit
  // 4515372916). Membership stays inside the chat's project so a malformed
  // cross-project edge can't delete another project's transcript, and live
  // in-flight switch targets of any member are swept up too — a target whose
  // index entry lands a beat after the click would otherwise resurface.
  const onDelete = useCallback(
    (entry: ProjectChatEntry) => {
      const { sessionIndex } = useAcpStore.getState()
      for (const memberId of conversationDeleteIds(sessionIndex, entry.id, liveSwitchSources)) {
        void deleteHistorySession(memberId).catch((error: unknown) => {
          warnFailure('delete', error)
          toast.error('Could not delete that chat. Try again.')
        })
      }
    },
    [deleteHistorySession]
  )

  const onOpenTerminal = useCallback(
    async (entry: ProjectChatEntry) => {
      if (!entry.cwd) return
      const outcome = await openTerminalAtCwd(projectId, entry.cwd)
      if (outcome.status === 'opened') {
        toast.success('Terminal opened', { description: `Opened at ${entry.cwd}` })
      } else if (outcome.status === 'no-pane') {
        toast.error('No active pane', {
          description: 'Cannot open terminal without an active workspace pane.'
        })
      } else {
        toast.error('Failed to open terminal', {
          description: outcome.error || 'Could not create a terminal.'
        })
      }
    },
    [projectId]
  )

  const onCopyPath = useCallback(async (cwd: string) => {
    await copyTextWithToast(cwd, {
      title: 'Path copied',
      description: cwd,
      failureTitle: 'Failed to copy path',
      logSource: LOG_SOURCE
    })
  }, [])

  const onCopyChatId = useCallback(async (entry: ProjectChatEntry) => {
    await copyTextWithToast(entry.id, {
      title: 'Chat ID copied',
      description: entry.id,
      failureTitle: 'Failed to copy chat ID',
      logSource: LOG_SOURCE
    })
  }, [])

  const onCopyChatReference = useCallback(async (entry: ProjectChatEntry) => {
    await copyChatReference(entry.id, entry.title, LOG_SOURCE)
  }, [])

  const onOpenInFileExplorer = useCallback(
    async (cwd: string) => {
      const result = await openerApi.revealInFileManager(cwd)
      if (!result.success) {
        // Fallback: copy the path so the user can still reach it.
        await onCopyPath(cwd)
      }
    },
    [onCopyPath]
  )

  return {
    onOpen,
    onOpenInSplit,
    onDelete,
    onOpenTerminal,
    onOpenInFileExplorer,
    onCopyPath,
    onCopyChatId,
    onCopyChatReference
  }
}
