import { Bot, User } from 'lucide-react'
import { memo, useMemo } from 'react'
import type { ContentBlock } from '@/lib/acp-api'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'

/** Concatenate the text of all text blocks; note any non-text block inline. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? (b.text ?? '') : `\n\n\`[${b.type}]\`\n\n`))
    .join('')
}

/** Agent reply rendered as sanitized markdown prose. */
function AgentProse({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element {
  const html = useMemo(() => renderChatMarkdown(blocksToText(blocks)), [blocks])
  return (
    <div
      className="chat-prose text-sm leading-relaxed text-foreground"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via renderChatMarkdown (DOMPurify)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface ChatMessageProps {
  message: ChatMessageType
}

function ChatMessageComponent({ message }: ChatMessageProps): React.JSX.Element {
  // Thought: collapsible, de-emphasized.
  if (message.role === 'thought') {
    const text = blocksToText(message.blocks)
    const lines = text.split('\n').filter((l) => l.trim().length > 0).length
    return (
      <details className="mx-4 my-1 border-l-2 border-border/70 pl-3">
        <summary className="cursor-pointer list-none text-[11px] italic text-muted-foreground marker:hidden">
          Thinking{lines > 0 ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ''}
          {message.streaming && '…'}
        </summary>
        <div className="mt-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
          {text}
        </div>
      </details>
    )
  }

  const isUser = message.role === 'user'

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {isUser ? <User size={12} /> : <Bot size={12} />}
        <span>{isUser ? 'You' : 'Agent'}</span>
        {message.streaming && (
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        )}
      </div>
      {isUser ? (
        <div
          className={cn(
            'rounded-lg bg-primary/[0.08] px-4 py-3 text-sm leading-relaxed text-foreground',
            'whitespace-pre-wrap break-words'
          )}
        >
          {blocksToText(message.blocks)}
        </div>
      ) : (
        <AgentProse blocks={message.blocks} />
      )}
    </div>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
