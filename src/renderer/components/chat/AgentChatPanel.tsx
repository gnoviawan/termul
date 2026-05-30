import { useCallback } from 'react'
import { toast } from 'sonner'
import { AgentHeader } from './AgentHeader'
import { ChatMessageList } from './ChatMessageList'
import { ChatInputBar } from './ChatInputBar'
import { useAcpStore, useAcpSession, useAcpMessages } from '@/stores/acp-store'
import type { SessionId } from '@/lib/acp-api'

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
  const sendPrompt = useAcpStore((s) => s.sendPrompt)
  const cancelPrompt = useAcpStore((s) => s.cancelPrompt)

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
      <ChatMessageList messages={messages} />
      <ChatInputBar
        busy={session.activeTurn}
        disabled={isClosed}
        onSend={handleSend}
        onCancel={handleCancel}
      />
    </div>
  )
}
