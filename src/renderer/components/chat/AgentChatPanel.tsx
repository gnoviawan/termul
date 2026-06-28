import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import { useAcpMessages, useAcpSession, useAcpStore } from '@/stores/acp-store'
import { ChatErrorNotice } from './ChatErrorNotice'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'
import { PermissionDialog } from './PermissionDialog'
import { PlanPanel } from './PlanPanel'

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
}

/**
 * Top-level agent-chat pane body. Renders the header, message thread, and input
 * for a single session. Mounted by PaneContent for `agent-chat` tabs.
 */
export function AgentChatPanel({ sessionId }: AgentChatPanelProps): React.JSX.Element {
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
  // The oldest pending permission for THIS session (resolve one to reveal the next).
  const pendingPermission = useAcpStore(
    useShallow(
      (s) => Object.values(s.pendingPermissions).find((p) => p.sessionId === sessionId) ?? null
    )
  )
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const sendPromptBlocks = useAcpStore((s) => s.sendPromptBlocks)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const setConfigOption = useAcpStore((s) => s.setConfigOption)
  const setMode = useAcpStore((s) => s.setMode)
  const setModel = useAcpStore((s) => s.setModel)

  // Composer seed (edit a message / pick a starter prompt) + dismissed-error tracking.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const seedComposer = useCallback((text: string) => setSeed({ text, nonce: Date.now() }), [])

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
    (configId: string, valueId: string) => {
      void setConfigOption(sessionId, configId, valueId).catch((err) => {
        toast.error(`Failed to set option: ${String(err)}`)
      })
    },
    [setConfigOption, sessionId]
  )

  const handleSetMode = useCallback(
    (modeId: string) => {
      void setMode(sessionId, modeId).catch((err) => {
        toast.error(`Failed to set mode: ${String(err)}`)
      })
    },
    [setMode, sessionId]
  )

  const handleSetModel = useCallback(
    (modelId: string) => {
      void setModel(sessionId, modelId).catch((err) => {
        toast.error(`Failed to set model: ${String(err)}`)
      })
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
  // Typing dots only before any thought or agent text arrives in the turn.
  const lastMessage = messages[messages.length - 1]
  const hasTurnOutput = lastMessage?.role === 'agent' || lastMessage?.role === 'thought'
  const showTyping = Boolean(session?.activeTurn) && !hasTurnOutput

  if (!session) {
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
    <div className="flex h-full flex-col bg-background">
      <ChatErrorNotice
        message={activeError}
        onRetry={canRetryLastUserTurn && !session.activeTurn ? handleRetry : undefined}
        onDismiss={() => setDismissedError(session.lastError)}
      />
      <PlanPanel entries={plan} />
      <ChatMessageList
        items={timeline}
        sessionId={session.id}
        agentId={session.agentId}
        showTyping={showTyping}
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
