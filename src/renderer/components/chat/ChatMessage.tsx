import { Bot, Brain, User } from 'lucide-react'
import { memo } from 'react'
import type { ContentBlock } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'

/** Render a single content block. Only text is fully rendered in P1. */
function renderBlock(block: ContentBlock, key: number): React.JSX.Element {
  if (block.type === 'text') {
    return (
      <span key={key} className="whitespace-pre-wrap break-words">
        {block.text ?? ''}
      </span>
    )
  }
  return (
    <span key={key} className="text-muted-foreground italic">
      [{block.type}]
    </span>
  )
}

interface ChatMessageProps {
  message: ChatMessageType
}

function ChatMessageComponent({ message }: ChatMessageProps): React.JSX.Element {
  const isUser = message.role === 'user'
  const isThought = message.role === 'thought'

  const Icon = isUser ? User : isThought ? Brain : Bot
  const label = isUser ? 'You' : isThought ? 'Thinking' : 'Agent'

  return (
    <div className={cn('flex flex-col gap-1 px-4 py-3', isThought && 'opacity-70')}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon size={12} />
        <span>{label}</span>
        {message.streaming && (
          <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        )}
      </div>
      <div
        className={cn(
          'text-sm leading-relaxed text-foreground',
          isThought && 'italic text-muted-foreground'
        )}
      >
        {message.blocks.map((b, i) => renderBlock(b, i))}
      </div>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
