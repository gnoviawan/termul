import { code as codePlugin } from '@streamdown/code'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo, useState } from 'react'
import { Streamdown } from 'streamdown'
import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Message, MessageContent } from '@/components/ui/message'
import type { ContentBlock } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { readAttachmentBytes } from '@/lib/attachment-api'
import { stripEmptyFences } from '@/lib/strip-empty-fences'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import {
  blockDisplayName,
  blockMimeType,
  blockToAttachmentData,
  blockUri,
  fileUrlToPath,
  guessMimeType,
  isLocalFileUri,
  uint8ToBase64
} from './chat-attachments'
import { type BubbleAlign, staggerChild } from './chat-motion'
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

/** Whether a content block represents an image. */
function blockIsImage(block: ContentBlock): boolean {
  if (block.type === 'image') return true
  if (blockMimeType(block)?.startsWith('image/')) return true
  const ref = (block.name as string | undefined) ?? blockUri(block) ?? ''
  return IMAGE_EXT_RE.test(ref)
}

/** A single media block rendered as an AI Elements grid attachment. */
function MediaGridItem({ block, id }: { block: ContentBlock; id: string }): React.JSX.Element {
  const initial = useMemo(() => blockToAttachmentData(block, id), [block, id])
  const [data, setData] = useState(initial)
  const name = blockDisplayName(block)
  // Images preview in a lightbox; non-image file/embedded blocks render as a
  // static icon card. Nothing opens a backing path — temp/file paths can live
  // in sandboxed dirs the OS opener refuses, which would surface as an error.
  const inlineImage = blockIsImage(block) && Boolean(data.url)

  useEffect(() => {
    // Inline image blocks and data/http URIs are already renderable; only
    // file:// images need a Tauri read to become a preview data URL.
    if (initial.url) return
    const uri = blockUri(block) ?? ''
    if (!isLocalFileUri(uri) || !blockIsImage(block)) return
    const resolvedPath = fileUrlToPath(uri)
    let cancelled = false
    void (async () => {
      try {
        const bytes = await readAttachmentBytes(resolvedPath)
        if (cancelled) return
        const mime = guessMimeType(resolvedPath)
        setData((prev) => ({ ...prev, url: `data:${mime};base64,${uint8ToBase64(bytes)}` }))
      } catch {
        // leave url empty — AttachmentPreview falls back to the image icon
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initial.url, block])

  const attachment = (
    <Attachment data={data} title={name} className={inlineImage ? 'cursor-zoom-in' : undefined}>
      <AttachmentPreview />
    </Attachment>
  )

  if (inlineImage) {
    return (
      <ImageLightbox src={data.url ?? ''} alt={name}>
        {attachment}
      </ImageLightbox>
    )
  }

  return attachment
}

/** Render image / resource blocks as grid attachment thumbnails. */
function MediaBlocks({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element | null {
  const media = mediaBlocks(blocks)
  if (media.length === 0) return null
  return (
    <Attachments variant="grid" className="ml-0 w-fit py-0.5">
      {media.map((block, i) => (
        <MediaGridItem key={`${block.type}-${i}`} block={block} id={`${block.type}-${i}`} />
      ))}
    </Attachments>
  )
}

/**
 * Shiki syntax-highlighting for fenced code blocks. Themes track the app's
 * light/dark mode via Streamdown's dual-theme output (github-light/dark).
 */
const CODE_PLUGIN = codePlugin
/** Live Mermaid diagram rendering for ```mermaid fences. */
const MERMAID_PLUGIN = mermaidPlugin
const STREAMDOWN_PLUGINS = { code: CODE_PLUGIN, mermaid: MERMAID_PLUGIN }

// Copy on code blocks, plus download (save an agent-generated file); no line
// numbers (chat snippets are short). Mermaid keeps its interactive controls.
const STREAMDOWN_CONTROLS = {
  code: { copy: true, download: true },
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true }
} as const

// Word-by-word reveal so replies feel like they stream even when an agent
// sends its text as one big chunk. `animated` uses the styles.css keyframes
// imported in main.tsx; already-visible words get duration 0 (no re-animation).
const STREAMDOWN_ANIMATED = { animation: 'blurIn', sep: 'word', duration: 350, stagger: 8 } as const

// Route link clicks to the OS browser rather than navigating inside the Tauri
// webview. Returning false aborts Streamdown's own navigation after we hand off.
const LINK_SAFETY = {
  enabled: true,
  onLinkCheck: (url: string): boolean => {
    void openerApi.openUrlWithSystemBrowser(url)
    return false
  }
}

/** Agent reply rendered as streaming-safe, hardened markdown via Streamdown. */
function AgentProse({
  blocks,
  streaming,
  reduced
}: {
  blocks: ContentBlock[]
  streaming: boolean
  reduced: boolean
}): React.JSX.Element {
  const text = useMemo(() => stripEmptyFences(blocksToText(blocks), streaming), [blocks, streaming])
  return (
    <div className="chat-streamdown text-sm leading-relaxed text-foreground">
      <Streamdown
        mode="streaming"
        isAnimating={streaming}
        caret="block"
        animated={reduced ? false : STREAMDOWN_ANIMATED}
        parseIncompleteMarkdown
        plugins={STREAMDOWN_PLUGINS}
        controls={STREAMDOWN_CONTROLS}
        lineNumbers={false}
        linkSafety={LINK_SAFETY}
        shikiTheme={['github-light', 'github-dark']}
      >
        {text}
      </Streamdown>
    </div>
  )
}

interface StaggerSectionProps {
  delay: number
  align: BubbleAlign
  reduced: boolean
  animateEnter: boolean
  children: React.ReactNode
  className?: string
}

/** Staggered enter for semantic chunks inside a message row. */
function StaggerSection({
  delay,
  align,
  reduced,
  animateEnter,
  children,
  className
}: StaggerSectionProps): React.JSX.Element {
  const enter = staggerChild(delay, reduced, align)
  return (
    <motion.div
      className={className}
      initial={animateEnter ? enter.initial : false}
      animate={enter.animate}
      transition={enter.transition}
    >
      {children}
    </motion.div>
  )
}

interface ChatMessageProps {
  message: ChatMessageType
  /** Tighter top padding when grouped under a previous same-role agent reply. */
  showHeader?: boolean
  /** True for the last item in the timeline (only it shows the streaming caret). */
  isLast?: boolean
  /** True when this agent reply ends its turn — only the tail shows the action bar. */
  isTurnTail?: boolean
  /** Full turn text (every agent reply in the turn) for the turn-level copy action. */
  turnText?: string
  /** Keep message actions visible without hover (last message in thread). */
  actionsPinned?: boolean
  /** Play enter animation for newly arrived messages (false for history on load). */
  animateEnter?: boolean
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
  actionsPinned = false,
  animateEnter = true,
  onEdit,
  onRetry
}: ChatMessageProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false

  const isUser = message.role === 'user'
  const text = blocksToText(message.blocks)
  const hasMedia = mediaBlocks(message.blocks).length > 0
  let staggerStep = 0
  const nextDelay = (): number => {
    const delay = staggerStep * 0.08
    staggerStep += 1
    return delay
  }

  if (isUser) {
    return (
      <div className="w-full">
        <Message align="end" className="py-2">
          <MessageContent className="w-fit max-w-[85%]">
            {hasMedia && (
              <StaggerSection
                delay={nextDelay()}
                align="end"
                reduced={reduced}
                animateEnter={animateEnter}
              >
                <MediaBlocks blocks={message.blocks} />
              </StaggerSection>
            )}
            {text.length > 0 && (
              <StaggerSection
                delay={nextDelay()}
                align="end"
                reduced={reduced}
                animateEnter={animateEnter}
              >
                <Bubble variant="tinted" align="end" className="max-w-full">
                  <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
                </Bubble>
              </StaggerSection>
            )}
            <StaggerSection
              delay={nextDelay()}
              align="end"
              reduced={reduced}
              animateEnter={animateEnter}
            >
              <MessageActions
                text={text}
                align="end"
                pinned={actionsPinned}
                onEdit={onEdit && text.length > 0 ? () => onEdit(text) : undefined}
              />
            </StaggerSection>
          </MessageContent>
        </Message>
      </div>
    )
  }

  const proseDelay = nextDelay()
  const mediaDelay = hasMedia ? nextDelay() : null
  const actionsDelay = nextDelay()

  return (
    <div className="w-full">
      <Message align="start" className={cn(showHeader ? 'py-2' : 'pb-2')}>
        <MessageContent className="min-w-0 flex-1">
          {/* Skip the ghost bubble entirely for attachment-only assistant turns
              so they don't render a blank shell above the media grid. The
              streaming caret still needs a bubble to live in while the turn is
              in progress, even before any text has arrived. */}
          {(text.length > 0 || (message.streaming && isLast)) && (
            <Bubble variant="ghost" className="w-fit max-w-full">
              <BubbleContent>
                <StaggerSection
                  delay={proseDelay}
                  align="start"
                  reduced={reduced}
                  animateEnter={animateEnter}
                >
                  {text.length > 0 && (
                    <AgentProse
                      blocks={message.blocks}
                      streaming={message.streaming && isLast}
                      reduced={reduced}
                    />
                  )}
                  {message.streaming && isLast && text.length === 0 && (
                    <span
                      aria-hidden="true"
                      className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-0.5 animate-caret-blink bg-primary align-middle motion-reduce:animate-none motion-reduce:opacity-100"
                    />
                  )}
                </StaggerSection>
              </BubbleContent>
            </Bubble>
          )}
          {hasMedia && mediaDelay != null && (
            <StaggerSection
              delay={mediaDelay}
              align="start"
              reduced={reduced}
              animateEnter={animateEnter}
            >
              <MediaBlocks blocks={message.blocks} />
            </StaggerSection>
          )}
          {!message.streaming && isTurnTail && (
            <StaggerSection
              delay={actionsDelay}
              align="start"
              reduced={reduced}
              animateEnter={animateEnter}
            >
              <MessageActions
                text={turnText ?? text}
                align="start"
                pinned={actionsPinned}
                onRetry={onRetry}
              />
            </StaggerSection>
          )}
        </MessageContent>
      </Message>
    </div>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
