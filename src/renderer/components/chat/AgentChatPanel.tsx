import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import type { AvailableCommand, ContentBlock, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
import { useAcpMessages, useAcpSession, useAcpStore } from '@/stores/acp-store'
import { AgentHeader } from './AgentHeader'
import { ChatInputBar } from './ChatInputBar'
import { ChatMessageList } from './ChatMessageList'
import { buildTimeline } from './chat-timeline'
import { PermissionDialog } from './PermissionDialog'
import { PlanPanel } from './PlanPanel'

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
  const agentStatus = useAcpStore((s) => (session ? s.agentStatus[session.agentId] : undefined))
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

  const timeline = useMemo(() => buildTimeline(messages, toolCalls), [messages, toolCalls])
  // Show the typing indicator while a turn is active but no agent text has
  // streamed yet (a trailing agent message means text is already rendering).
  const lastMessage = messages[messages.length - 1]
  const hasAgentTextTail = lastMessage?.role === 'agent'
  const showTyping = Boolean(session?.activeTurn) && !hasAgentTextTail

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active chat for this pane.
      </div>
    )
  }

  const isClosed = session.status === 'closed'

  return (
    <div className="flex h-full flex-col bg-background">
      <AgentHeader session={session} agentStatus={agentStatus} />
      {session.lastError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-2xs text-red-400">
          {session.lastError}
        </div>
      )}
      <PlanPanel entries={plan} />
      <ChatMessageList items={timeline} agentId={session.agentId} showTyping={showTyping} />
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
      />
      {pendingPermission && !isClosed && <PermissionDialog permission={pendingPermission} />}
    </div>
  )
}
