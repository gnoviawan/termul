import { readFile } from '@tauri-apps/plugin-fs'
import { motion, useReducedMotion } from 'framer-motion'
import { Brain, FileText } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Message, MessageContent } from '@/components/ui/message'
import type { ContentBlock } from '@/lib/acp-api'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { copyText } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { blockDisplayName, blockMimeType, guessMimeType, uint8ToBase64 } from './chat-attachments'
import { bubbleEnter } from './chat-motion'
import { MessageActions } from './MessageActions'

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

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i

function blockUri(block: ContentBlock): string | undefined {
  const direct = block.uri as string | undefined
  if (direct) return direct
  return (block.resource as { uri?: string } | undefined)?.uri
}

/** Whether a content block represents an image. */
function blockIsImage(block: ContentBlock): boolean {
  if (block.type === 'image') return true
  if (blockMimeType(block)?.startsWith('image/')) return true
  const ref = (block.name as string | undefined) ?? blockUri(block) ?? ''
  return IMAGE_EXT_RE.test(ref)
}

/** Convert a `file://` URL back to a filesystem path readable by plugin-fs. */
function fileUrlToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  let p = decodeURI(uri.slice('file://'.length))
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // /C:/x -> C:/x
  return p
}

type ImageSource = { url: string } | { path: string } | null

/** Resolve a renderable image source for a block: a ready URL or a path to read. */
function imageSourceForBlock(block: ContentBlock): ImageSource {
  if (!blockIsImage(block)) return null
  const data = block.data as string | undefined
  const blob = (block.resource as { blob?: string } | undefined)?.blob
  const inline = data ?? blob
  if (inline) return { url: `data:${blockMimeType(block) ?? 'image/png'};base64,${inline}` }
  const uri = blockUri(block)
  if (!uri) return null
  if (uri.startsWith('data:') || uri.startsWith('http')) return { url: uri }
  if (uri.startsWith('file:') || uri.startsWith('/') || /^[A-Za-z]:/.test(uri)) {
    return { path: fileUrlToPath(uri) }
  }
  return null
}

function ImageCard({ src, name }: { src: string; name: string }): React.JSX.Element {
  return (
    <Attachment orientation="vertical" className="w-44">
      <AttachmentMedia variant="image">
        <ImageLightbox src={src} alt={name}>
          <img src={src} alt={name} className="cursor-zoom-in" />
        </ImageLightbox>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
      </AttachmentContent>
    </Attachment>
  )
}

function FileCard({ block, name }: { block: ContentBlock; name: string }): React.JSX.Element {
  const description =
    block.type === 'resource_link'
      ? 'Linked file'
      : block.type === 'resource'
        ? 'Embedded text'
        : (blockMimeType(block) ?? block.type)
  return (
    <Attachment className="w-56">
      <AttachmentMedia>
        <FileText />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>{description}</AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}

/** A single media block: image thumbnail (incl. lazily-read `file://`) or file card. */
function MediaBlockCard({ block }: { block: ContentBlock }): React.JSX.Element {
  const name = blockDisplayName(block)
  const source = imageSourceForBlock(block)
  const path = source && 'path' in source ? source.path : null
  const [pathSrc, setPathSrc] = useState<string | null>(null)
  const [pathFailed, setPathFailed] = useState(false)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    void (async () => {
      try {
        const bytes = await readFile(path)
        if (!cancelled) setPathSrc(`data:${guessMimeType(path)};base64,${uint8ToBase64(bytes)}`)
      } catch {
        if (!cancelled) setPathFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  const readyUrl = source && 'url' in source ? source.url : pathSrc
  if (readyUrl) return <ImageCard src={readyUrl} name={name} />
  if (path && !pathFailed) {
    // Image file still loading — reserve the thumbnail slot.
    return (
      <Attachment orientation="vertical" className="w-44">
        <AttachmentMedia variant="image">
          <div className="size-full animate-pulse bg-muted" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{name}</AttachmentTitle>
        </AttachmentContent>
      </Attachment>
    )
  }
  return <FileCard block={block} name={name} />
}

/** Render image / resource blocks as attachment cards. */
function MediaBlocks({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element | null {
  const media = mediaBlocks(blocks)
  if (media.length === 0) return null
  return (
    <AttachmentGroup className="max-w-full">
      {media.map((block, i) => (
        <MediaBlockCard key={`${block.type}-${i}`} block={block} />
      ))}
    </AttachmentGroup>
  )
}

/**
 * Attach a hover "Copy" button to every `<pre>` code block under `root`.
 * Runs against the live DOM (post-sanitize) so it can't reintroduce markup the
 * sanitizer stripped. Idempotent via a data flag; cleans up its listeners.
 */
function enhanceCodeBlocks(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = []
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.dataset.copyEnhanced) continue
    pre.dataset.copyEnhanced = 'true'
    pre.style.position = 'relative'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-code-copy'
    btn.textContent = 'Copy'
    const onClick = (): void => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
      void copyText(code).then((ok) => {
        btn.textContent = ok ? 'Copied' : 'Failed'
        btn.classList.toggle('is-copied', ok)
        setTimeout(() => {
          btn.textContent = 'Copy'
          btn.classList.remove('is-copied')
        }, 1500)
      })
    }
    btn.addEventListener('click', onClick)
    pre.appendChild(btn)
    cleanups.push(() => {
      btn.removeEventListener('click', onClick)
      btn.remove()
      delete pre.dataset.copyEnhanced
    })
  }
  return () => {
    for (const c of cleanups) c()
  }
}

/** Agent reply rendered as sanitized markdown prose. */
function AgentProse({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element {
  const html = useMemo(() => renderChatMarkdown(blocksToText(blocks)), [blocks])
  const ref = useRef<HTMLDivElement>(null)
  // Re-run after each render of new markdown so freshly-streamed code blocks get
  // a copy button; `html` is the change trigger even though it's read indirectly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html drives re-enhancement
  useEffect(() => {
    if (!ref.current) return
    return enhanceCodeBlocks(ref.current)
  }, [html])
  return (
    <div
      ref={ref}
      className="chat-prose text-sm leading-relaxed text-foreground"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via renderChatMarkdown (DOMPurify)
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

interface ChatMessageProps {
  message: ChatMessageType
  /** Hide the agent header (grouped under the previous same-role reply). */
  showHeader?: boolean
  /** True for the last item in the timeline (only it shows the streaming caret). */
  isLast?: boolean
  /** True when this agent reply ends its turn — only the tail shows the action bar. */
  isTurnTail?: boolean
  /** Full turn text (every agent reply in the turn) for the turn-level copy action. */
  turnText?: string
  /** Seed the composer with this message's text for editing (user turns). */
  onEdit?: (text: string) => void
  /** Re-run the latest user turn (assistant turns). */
  onRetry?: () => void
}

function ChatMessageComponent({
  message,
  showHeader = true,
  isLast = false,
  isTurnTail = false,
  turnText,
  onEdit,
  onRetry
}: ChatMessageProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false

  // Thought: collapsible, de-emphasized, surfaced as a status marker. The
  // "Thinking…" shimmer runs only while this thought is the live tail; once any
  // output (a tool call or the reply) follows it, the thinking step is done —
  // even though its `streaming` flag stays set until the whole turn finalizes.
  if (message.role === 'thought') {
    const text = blocksToText(message.blocks)
    const lines = text.split('\n').filter((l) => l.trim().length > 0).length
    const thinking = message.streaming && isLast
    return (
      <details className="px-1 py-1">
        <summary className="cursor-pointer list-none marker:hidden">
          <Marker className="inline-flex italic">
            <MarkerIcon>
              <Brain />
            </MarkerIcon>
            <MarkerContent className={cn(thinking && 'shimmer')}>
              {thinking ? 'Thinking…' : 'Thought'}
              {lines > 0 ? ` · ${lines} line${lines === 1 ? '' : 's'}` : ''}
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
    const enter = bubbleEnter('end', reduced)
    return (
      <motion.div
        className="w-full"
        initial={enter.initial}
        animate={enter.animate}
        transition={enter.transition}
      >
        <Message align="end" className="py-2">
          <MessageContent className="max-w-[85%]">
            <MediaBlocks blocks={message.blocks} />
            {text.length > 0 && (
              <Bubble variant="tinted" align="end">
                <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
              </Bubble>
            )}
            <MessageActions
              text={text}
              align="end"
              onEdit={onEdit && text.length > 0 ? () => onEdit(text) : undefined}
            />
          </MessageContent>
        </Message>
      </motion.div>
    )
  }

  const enter = bubbleEnter('start', reduced)
  return (
    <motion.div
      className="w-full"
      initial={enter.initial}
      animate={enter.animate}
      transition={enter.transition}
    >
      <Message align="start" className={cn(showHeader ? 'py-2' : 'pb-2')}>
        <MessageContent className="min-w-0 flex-1">
          <Bubble variant="ghost" className="w-fit max-w-full">
            <BubbleContent>
              <AgentProse blocks={message.blocks} />
              {message.streaming && isLast && (
                <span
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-0.5 animate-caret-blink bg-primary align-middle motion-reduce:animate-none motion-reduce:opacity-100"
                />
              )}
              <MediaBlocks blocks={message.blocks} />
            </BubbleContent>
          </Bubble>
          {!message.streaming && isTurnTail && (
            <MessageActions text={turnText ?? text} align="start" onRetry={onRetry} />
          )}
        </MessageContent>
      </Message>
    </motion.div>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
