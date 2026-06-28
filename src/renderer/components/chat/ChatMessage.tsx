import { readFile } from '@tauri-apps/plugin-fs'
import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Message, MessageContent } from '@/components/ui/message'
import type { ContentBlock } from '@/lib/acp-api'
import { inlineCodeClass } from '@/lib/chat-inline-code'
import { renderChatMarkdown } from '@/lib/chat-markdown'
import { copyText } from '@/lib/copy-text'
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
        const bytes = await readFile(resolvedPath)
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

/** Lucide-style SVGs for the DOM-injected code-block copy control. */
const CODE_COPY_CLIPBOARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`
const CODE_COPY_CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`

type CodeCopyIconState = 'copy' | 'copied' | 'failed'

function setCodeCopyButtonIcon(btn: HTMLButtonElement, state: CodeCopyIconState): void {
  if (state === 'copied') {
    btn.innerHTML = CODE_COPY_CHECK_SVG
    btn.setAttribute('aria-label', 'Copied')
    btn.title = 'Copied'
    return
  }
  btn.innerHTML = CODE_COPY_CLIPBOARD_SVG
  btn.setAttribute('aria-label', state === 'failed' ? 'Failed to copy' : 'Copy')
  btn.title = state === 'failed' ? 'Failed to copy' : 'Copy'
}

/**
 * Post-process sanitized prose: inline code pill classes + `<pre>` copy buttons.
 * Runs against the live DOM so it can't reintroduce markup the sanitizer stripped.
 */
function enhanceProse(root: HTMLElement): () => void {
  const cleanups: Array<() => void> = []

  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (code.closest('pre')) continue
    const cls = inlineCodeClass(code.textContent ?? '')
    code.classList.add(cls)
  }

  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.dataset.copyEnhanced) continue
    pre.dataset.copyEnhanced = 'true'
    pre.style.position = 'relative'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-code-copy'
    setCodeCopyButtonIcon(btn, 'copy')
    const onClick = (): void => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
      void copyText(code).then((ok) => {
        setCodeCopyButtonIcon(btn, ok ? 'copied' : 'failed')
        btn.classList.toggle('is-copied', ok)
        setTimeout(() => {
          setCodeCopyButtonIcon(btn, 'copy')
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
    return enhanceProse(ref.current)
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
          <MessageContent className="max-w-[85%]">
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
                <Bubble variant="tinted" align="end">
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
          <Bubble variant="ghost" className="w-fit max-w-full">
            <BubbleContent>
              <StaggerSection
                delay={proseDelay}
                align="start"
                reduced={reduced}
                animateEnter={animateEnter}
              >
                <AgentProse blocks={message.blocks} />
                {message.streaming && isLast && (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-0.5 animate-caret-blink bg-primary align-middle motion-reduce:animate-none motion-reduce:opacity-100"
                  />
                )}
              </StaggerSection>
            </BubbleContent>
          </Bubble>
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
