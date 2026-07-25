import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { Button } from '@/components/ui/button'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import {
  configIdFromReuseKey,
  useAcpMessages,
  useAcpSession,
  useAcpStore,
  usePromptQueue
} from '@/stores/acp-store'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'
import { PermissionDialog } from './PermissionDialog'
import { PlanPanel } from './PlanPanel'
import { PlanSupportHint } from './PlanSupportHint'

/** Concatenate the text blocks of a message into a single string. */
function messageText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

const EMPTY_COMMANDS: AvailableCommand[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []
const EMPTY_PLAN: PlanEntry[] = []

interface AgentChatPanelProps {
  sessionId: SessionId
  /**
   * Whether this panel's tab is the pane's active tab. Gates the restored-tab
   * rehydrate so only visible chats trigger `openHistorySession` (a hidden
   * restored tab must not cold-spawn an agent in the background).
   */
  isVisible?: boolean
}

/**
 * Top-level agent-chat pane body. Renders the header, message thread, and input
 * for a single session. Mounted by PaneContent for `agent-chat` tabs.
 */
export function AgentChatPanel({
  sessionId,
  isVisible = true
}: AgentChatPanelProps): React.JSX.Element {
  const session = useAcpSession(sessionId)
  const messages = useAcpMessages(sessionId)
  const imageCapable = useAcpStore((s) =>
    session ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.image) : false
  )
  const embedCapable = useAcpStore((s) =>
    session
      ? Boolean(s.agents[session.agentId]?.capabilities?.promptCapabilities?.embeddedContext)
      : false
  )
  const commands = useAcpStore((s) => s.commands[sessionId] ?? EMPTY_COMMANDS)
  const toolCalls = useAcpStore((s) => s.toolCalls[sessionId] ?? EMPTY_TOOL_CALLS)
  const plan = useAcpStore((s) => s.plans[sessionId] ?? EMPTY_PLAN)
  // Registry/config id for plan compliance — live agentId is a spawn UUID.
  const planAgentId = useAcpStore((s) => {
    const liveSession = s.sessions?.[sessionId]
    if (!liveSession) return ''
    const reuseKey = Object.keys(s.configToLiveAgent ?? {}).find(
      (k) => s.configToLiveAgent[k] === liveSession.agentId
    )
    if (reuseKey) return configIdFromReuseKey(reuseKey)
    const fromIndex = s.sessionIndex?.find((e) => e.id === sessionId)?.agentConfigId
    return fromIndex ?? liveSession.agentId
  })
  // The oldest pending permission for THIS session (resolve one to reveal the next).
  const pendingPermission = useAcpStore(
    useShallow(
      (s) => Object.values(s.pendingPermissions).find((p) => p.sessionId === sessionId) ?? null
    )
  )
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const sendPromptBlocks = useAcpStore((s) => s.sendPromptBlocks)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const removeQueuedPrompt = useAcpStore((s) => s.removeQueuedPrompt)
  const sendQueuedPromptNow = useAcpStore((s) => s.sendQueuedPromptNow)
  const promptQueue = usePromptQueue(sessionId)
  const setConfigOption = useAcpStore((s) => s.setConfigOption)
  const setMode = useAcpStore((s) => s.setMode)
  const setModel = useAcpStore((s) => s.setModel)

  // Restored-tab rehydration: a persisted `agent-chat` tab can outlive its
  // in-memory session (app restart). When this panel is visible, its session
  // record is missing, and history exists for the id, reopen it from history
  // (deduped store-side against a concurrent sidebar open).
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const hasHistoryEntry = useAcpStore((s) => s.sessionIndex.some((e) => e.id === sessionId))
  const isOpeningHistory = useAcpStore((s) => Boolean(s.openingHistoryIds[sessionId]))
  const isLaunchingSession = useAcpStore((s) => Boolean(s.launchingSessionIds[sessionId]))
  const [rehydrateError, setRehydrateError] = useState<string | null>(null)
  useEffect(() => {
    if (!isVisible || session || !hasHistoryEntry || rehydrateError) return
    let cancelled = false
    void openHistorySession(sessionId).catch((err) => {
      if (!cancelled) setRehydrateError(String(err))
    })
    return () => {
      cancelled = true
    }
  }, [isVisible, session, hasHistoryEntry, rehydrateError, openHistorySession, sessionId])

  // Composer seed (edit a message / pick a starter prompt) + dismissed-error tracking.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const seedComposer = useCallback((text: string) => setSeed({ text, nonce: Date.now() }), [])

  const handleRemoveQueued = useCallback(
    (queueId: string) => {
      removeQueuedPrompt(sessionId, queueId)
    },
    [removeQueuedPrompt, sessionId]
  )

  const handleSendQueuedNow = useCallback(
    (queueId: string) => {
      void sendQueuedPromptNow(sessionId, queueId).catch((err) => {
        toast.error(`Failed to send queued message: ${String(err)}`)
      })
    },
    [sendQueuedPromptNow, sessionId]
  )

  const handleSend = useCallback(
    (text: string) => {
      void sendPrompt(sessionId, text).catch((err) => {
        toast.error(`Failed to send: ${String(err)}`)
      })
    },
    [sendPrompt, sessionId]
  )

  const handleSendBlocks = useCallback(
    (blocks: ContentBlock[]) => {
      void sendPromptBlocks(sessionId, blocks).catch((err) => {
        toast.error(`Failed to send: ${String(err)}`)
      })
    },
    [sendPromptBlocks, sessionId]
  )

  const handleCancel = useCallback(() => {
    void cancelPrompt(sessionId).catch((err) => {
      toast.error(`Failed to cancel: ${String(err)}`)
    })
  }, [cancelPrompt, sessionId])

  const handleSetConfig = useCallback(
    async (configId: string, valueId: string) => {
      try {
        await setConfigOption(sessionId, configId, valueId)
      } catch (err) {
        toast.error(`Failed to set option: ${String(err)}`)
        throw err
      }
    },
    [setConfigOption, sessionId]
  )

  const handleSetMode = useCallback(
    async (modeId: string) => {
      try {
        await setMode(sessionId, modeId)
      } catch (err) {
        toast.error(`Failed to set mode: ${String(err)}`)
        throw err
      }
    },
    [setMode, sessionId]
  )

  const handleSetModel = useCallback(
    async (modelId: string) => {
      try {
        await setModel(sessionId, modelId)
      } catch (err) {
        toast.error(`Failed to set model: ${String(err)}`)
        throw err
      }
    },
    [setModel, sessionId]
  )

  // Most recent user turn — drives the regenerate/retry affordances. We keep
  // the original blocks so retrying re-sends structured attachments (images,
  // resource/file-ref), not just the concatenated text; an attachment-only
  // prompt (no text) is still retryable via the blocks.
  const lastUserBlocks = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].blocks
    }
    return null
  }, [messages])
  const lastUserText = lastUserBlocks ? messageText(lastUserBlocks) : ''
  const canRetryLastUserTurn = Boolean(
    lastUserBlocks?.some((b) => b.type !== 'text' || (b.text ?? '').trim().length > 0)
  )

  const handleRetry = useCallback(() => {
    if (!lastUserBlocks || !canRetryLastUserTurn) return
    setDismissedError(session?.lastError ?? null)
    const hasStructuredBlocks = lastUserBlocks.some((b) => b.type !== 'text')
    const task = hasStructuredBlocks
      ? sendPromptBlocks(sessionId, lastUserBlocks)
      : sendPrompt(sessionId, lastUserText.trim())
    void task.catch((err) => {
      toast.error(`Failed to send: ${String(err)}`)
    })
  }, [
    lastUserBlocks,
    canRetryLastUserTurn,
    lastUserText,
    sendPrompt,
    sendPromptBlocks,
    sessionId,
    session?.lastError
  ])

  const timeline = useMemo(
    () => consolidateThoughtGroups(buildTimeline(messages, toolCalls)),
    [messages, toolCalls]
  )
  // Keep the bottom cue visible for the complete turn, including while thought,
  // tool, and agent-message surfaces stream their own local progress.
  const showRunningIndicator = Boolean(session?.activeTurn)

  if (!session) {
    if (rehydrateError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <div className="max-w-md px-6 text-center">Failed to restore chat: {rehydrateError}</div>
          <Button type="button" variant="outline" size="sm" onClick={() => setRehydrateError(null)}>
            Retry
          </Button>
        </div>
      )
    }
    if (isOpeningHistory || hasHistoryEntry) {
      return (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Restoring chat…
        </div>
      )
    }
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active chat for this pane.
      </div>
    )
  }

  const isClosed = session.status === 'closed'
  const activeError =
    session.lastError && session.lastError !== dismissedError ? session.lastError : null

  return (
    <div className="@container flex h-full flex-col bg-background">
      {(isLaunchingSession ||
        (session.status === 'initializing' && !session.agentId) ||
        (isLaunchingSession && session.activeTurn)) && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Starting agent…
        </div>
      )}
      {isClosed && isOpeningHistory && !isLaunchingSession && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          Reconnecting to agent…
        </div>
      )}
      {isClosed && !isOpeningHistory && !isLaunchingSession && hasHistoryEntry && (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <span>Chat disconnected.</span>
          <button
            type="button"
            onClick={() => {
              void openHistorySession(sessionId).catch((err) => {
                toast.error(`Failed to reconnect chat: ${String(err)}`)
              })
            }}
            className="rounded-md border border-border/60 px-2 py-0.5 text-xs hover:bg-background/60"
          >
            Reconnect
          </button>
        </div>
      )}
      <ChatErrorNotice
        message={activeError}
        onRetry={canRetryLastUserTurn && !session.activeTurn ? handleRetry : undefined}
        onDismiss={() => setDismissedError(session.lastError)}
      />
      <PlanSupportHint agentId={planAgentId} planEntryCount={plan.length} />
      <PlanPanel entries={plan} />
      <ChatMessageList
        items={timeline}
        sessionId={session.id}
        agentId={session.agentId}
        showRunningIndicator={showRunningIndicator}
        onEditMessage={seedComposer}
        onRetry={canRetryLastUserTurn && !session.activeTurn ? handleRetry : undefined}
      />
      <ChatInputBar
        session={session}
        busy={session.activeTurn}
        disabled={isClosed}
        imageCapable={imageCapable}
        embedCapable={embedCapable}
        onSend={handleSend}
        onSendBlocks={handleSendBlocks}
        onCancel={handleCancel}
        queue={promptQueue}
        onRemoveQueued={handleRemoveQueued}
        onSendQueuedNow={handleSendQueuedNow}
        commands={commands}
        configOptions={session.configOptions}
        modes={session.modes}
        onSetConfig={handleSetConfig}
        onSetMode={handleSetMode}
        onSetModel={handleSetModel}
        seedText={seed?.text}
        seedNonce={seed?.nonce}
      />
      {pendingPermission && !isClosed && <PermissionDialog permission={pendingPermission} />}
    </div>
  )
}
