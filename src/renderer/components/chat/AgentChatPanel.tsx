import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import type { AvailableCommand, PlanEntry, SessionId, ToolCall } from '@/lib/acp-api'
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
  const pendingAuth = useAcpStore((s) => (session ? s.pendingAuth[session.agentId] : undefined))
  const authenticate = useAcpStore((s) => s.authenticate)
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
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)
  const setConfigOption = useAcpStore((s) => s.setConfigOption)
  const setMode = useAcpStore((s) => s.setMode)

  const handleSend = useCallback(
    (text: string) => {
      void sendPrompt(sessionId, text).catch((err) => {
        toast.error(`Failed to send: ${String(err)}`)
      })
    },
    [sendPrompt, sessionId]
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
        <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1 text-[11px] text-red-400">
          {session.lastError}
        </div>
      )}
      {pendingAuth && pendingAuth.methods.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-400">
          <span>{pendingAuth.message ?? 'This agent requires authentication.'}</span>
          {pendingAuth.methods.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                void authenticate(session.agentId, m.id).catch((err) => {
                  toast.error(`Authentication failed: ${String(err)}`)
                })
              }}
              className="rounded border border-amber-500/40 px-2 py-0.5 font-medium hover:bg-amber-500/20"
              title={m.description ?? m.name}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      <PlanPanel entries={plan} />
      <ChatMessageList items={timeline} agentId={session.agentId} showTyping={showTyping} />
      <ChatInputBar
        session={session}
        busy={session.activeTurn}
        disabled={isClosed || Boolean(pendingAuth)}
        onSend={handleSend}
        onCancel={handleCancel}
        commands={commands}
        configOptions={session.configOptions}
        modes={session.modes}
        onSetConfig={handleSetConfig}
        onSetMode={handleSetMode}
      />
      {pendingPermission && !isClosed && <PermissionDialog permission={pendingPermission} />}
    </div>
  )
}
