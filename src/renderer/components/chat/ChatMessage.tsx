import { Brain, FileText } from 'lucide-react'
import { memo, useMemo } from 'react'
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Message, MessageContent, MessageHeader } from '@/components/ui/message'
import type { AgentId, ContentBlock } from '@/lib/acp-api'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { AgentBadge } from './AgentBadge'
import { blockDisplayName, blockMimeType } from './chat-attachments'

/** Concatenate the text of all text blocks. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/** Non-text content blocks (image / resource / etc). */
function mediaBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((b) => b.type !== 'text')
}

function blockImageSrc(block: ContentBlock): string | null {
  const data = block.data as string | undefined
  const mimeType = (block.mimeType as string | undefined) ?? 'image/png'
  if (data) return `data:${mimeType};base64,${data}`
  const uri = block.uri as string | undefined
  if (uri && (uri.startsWith('data:') || uri.startsWith('http') || uri.startsWith('file:'))) {
    return uri
  }
  return null
}

/** Render image / resource blocks as attachment cards. */
function MediaBlocks({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element | null {
  const media = mediaBlocks(blocks)
  if (media.length === 0) return null
  return (
    <AttachmentGroup className="max-w-full">
      {media.map((block, i) => {
        const src = block.type === 'image' ? blockImageSrc(block) : null
        const name = blockDisplayName(block)
        if (src) {
          return (
            <Attachment key={`${block.type}-${i}`} orientation="vertical" className="w-44">
              <AttachmentMedia variant="image">
                <img src={src} alt={name} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{name}</AttachmentTitle>
              </AttachmentContent>
            </Attachment>
          )
        }
        const description =
          block.type === 'resource_link'
            ? 'Linked file'
            : block.type === 'resource'
              ? 'Embedded text'
              : (blockMimeType(block) ?? block.type)
        return (
          <Attachment key={`${block.type}-${i}`} className="w-56">
            <AttachmentMedia>
              <FileText />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{name}</AttachmentTitle>
              <AttachmentDescription>{description}</AttachmentDescription>
            </AttachmentContent>
          </Attachment>
        )
      })}
    </AttachmentGroup>
  )
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
  agentId: AgentId
}

function ChatMessageComponent({ message, agentId }: ChatMessageProps): React.JSX.Element {
  // Thought: collapsible, de-emphasized, surfaced as a status marker.
  if (message.role === 'thought') {
    const text = blocksToText(message.blocks)
    const lines = text.split('\n').filter((l) => l.trim().length > 0).length
    return (
      <details className="px-1 py-1">
        <summary className="cursor-pointer list-none marker:hidden">
          <Marker className="inline-flex italic">
            <MarkerIcon>
              <Brain />
            </MarkerIcon>
            <MarkerContent className={cn(message.streaming && 'shimmer')}>
              Thinking{lines > 0 ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ''}
              {message.streaming && '…'}
            </MarkerContent>
          </Marker>
        </summary>
        <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border/70 pl-3 text-xs italic text-muted-foreground">
          {text}
        </div>
      </details>
    )
  }

  const isUser = message.role === 'user'
  const text = blocksToText(message.blocks)

  if (isUser) {
    return (
      <Message align="end" className="py-2 duration-200 animate-in fade-in-0">
        <MessageContent>
          <MediaBlocks blocks={message.blocks} />
          {text.length > 0 && (
            <Bubble variant="tinted" align="end">
              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
            </Bubble>
          )}
        </MessageContent>
      </Message>
    )
  }

  return (
    <Message align="start" className="py-2 duration-200 animate-in fade-in-0">
      <MessageContent>
        <MessageHeader className="flex items-center gap-1.5">
          <AgentBadge agentId={agentId} iconSize={12} />
          {message.streaming && (
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
          )}
        </MessageHeader>
        <Bubble variant="ghost">
          <BubbleContent>
            <AgentProse blocks={message.blocks} />
            <MediaBlocks blocks={message.blocks} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
