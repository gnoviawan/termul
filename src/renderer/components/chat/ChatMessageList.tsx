import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import type { AgentId } from '@/lib/acp-api'
import { AgentBadge } from './AgentBadge'
import { ChatMessage } from './ChatMessage'
import type { TimelineItem } from './chat-timeline'
import { ToolCallCard } from './ToolCallCard'

interface ChatMessageListProps {
  items: TimelineItem[]
  /** Agent behind this session (drives the agent name/icon on replies). */
  agentId: AgentId
  /** True while a turn is in flight but no agent text has streamed yet. */
  showTyping: boolean
}

/**
 * Scrollable message thread built on the MessageScroller engine. Auto-follows
 * the live edge only while the reader is pinned to the bottom; a jump-to-latest
 * control appears otherwise. New user turns anchor the scroll position.
 */
export function ChatMessageList({
  items,
  agentId,
  showTyping
}: ChatMessageListProps): React.JSX.Element {
  if (items.length === 0 && !showTyping) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say something to get started.
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport className="px-5 py-4">
            <MessageScrollerContent className="mx-auto w-full max-w-3xl">
              {items.map((it) => (
                <MessageScrollerItem
                  key={it.key}
                  messageId={it.key}
                  scrollAnchor={it.kind === 'message' && it.message.role === 'user'}
                >
                  {it.kind === 'tool' ? (
                    <ToolCallCard toolCall={it.tool} />
                  ) : (
                    <ChatMessage message={it.message} agentId={agentId} />
                  )}
                </MessageScrollerItem>
              ))}
              {showTyping && (
                <MessageScrollerItem>
                  <TypingIndicator agentId={agentId} />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}

/** "Agent is typing" status shown before the first text chunk streams. */
function TypingIndicator({ agentId }: { agentId: AgentId }): React.JSX.Element {
  return (
    <div className="px-1 py-2">
      <div className="mb-1.5">
        <AgentBadge agentId={agentId} iconSize={12} />
      </div>
      <Marker role="status">
        <MarkerIcon>
          <Spinner className="size-3.5" />
        </MarkerIcon>
        <MarkerContent className="shimmer">Thinking…</MarkerContent>
      </Marker>
    </div>
  )
}
