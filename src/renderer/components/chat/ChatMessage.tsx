import { code as codePlugin } from '@streamdown/code'
import { mermaid as mermaidPlugin } from '@streamdown/mermaid'
import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  type Components,
  defaultRemarkPlugins,
  type LinkSafetyConfig,
  type LinkSafetyModalProps,
  Streamdown
} from 'streamdown'
import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { ImageLightbox } from '@/components/ui/image-lightbox'
import { Message, MessageContent } from '@/components/ui/message'
import type { ContentBlock } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { readAttachmentBytes } from '@/lib/attachment-api'
import { type FilePathResolutionContext, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { parseSkillSegments, replaceSkillTokensInline } from '@/lib/skill-tokens'
import { stripEmptyFences } from '@/lib/strip-empty-fences'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import {
  blockData,
  blockDisplayName,
  blockMimeType,
  blockResource,
  blockToAttachmentData,
  blockUri,
  fileUrlToPath,
  guessMimeType,
  isLocalFileUri,
  uint8ToBase64
} from './chat-attachments'
import { ChatMarkdownCode } from './chat-markdown-code'
import { filePathFromHref, remarkFilePathLinks } from './chat-markdown-file-links'
import { ChatMarkdownTable } from './chat-markdown-table'
import { type BubbleAlign, staggerChild } from './chat-motion'
import { MessageActions } from './MessageActions'
import { SkillChip } from './SkillChip'

const FILE_PATH_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkFilePathLinks]

/** Concatenate the text of all text blocks. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/**
 * Render a user message's text, swapping inline skill tokens for read-only
 * `SkillChip` pills. Plain text (no tokens) renders verbatim with
 * `whitespace-pre-wrap` to preserve the original spacing. `MessageActions`
 * still receives the raw token text so editing re-seeds the composer with the
 * tokens (chips re-render inline) and copy degrades gracefully (private-use
 * sentinels are invisible in most fonts).
 */
function UserMessageText({ text }: { text: string }): React.JSX.Element {
  const segments = parseSkillSegments(text)
  return (
    <BubbleContent className="whitespace-pre-wrap break-words">
      {segments.length === 0
        ? text
        : segments.map((seg, i) =>
            seg.kind === 'skill' ? (
              <SkillChip key={`skill-${i}`} name={seg.name} />
            ) : (
              <span key={`text-${i}`}>{seg.text}</span>
            )
          )}
    </BubbleContent>
  )
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

const MAX_INLINE_RESOURCE_TEXT = 32 * 1024
const MAX_INLINE_AUDIO_BYTES = 20 * 1024 * 1024

/** Return only bounded inline audio sources; remote URLs must not auto-load. */
function inlineAudioUrl(block: ContentBlock): string | null {
  if (block.type !== 'audio' || !blockMimeType(block)?.startsWith('audio/')) return null
  const data = blockData(block)
  if (!data) return null
  if (data.startsWith('blob:')) return data
  if (data.startsWith('data:audio/')) {
    return data.length <= MAX_INLINE_AUDIO_BYTES * 1.4 ? data : null
  }
  if (data.startsWith('data:')) return null
  if (data.length > MAX_INLINE_AUDIO_BYTES * 1.4) return null
  return `data:${blockMimeType(block)};base64,${data}`
}

function ResourceText({ block }: { block: ContentBlock }): React.JSX.Element | null {
  const text = blockResource(block)?.text
  if (typeof text !== 'string') return null
  const boundedText =
    text.length > MAX_INLINE_RESOURCE_TEXT ? `${text.slice(0, MAX_INLINE_RESOURCE_TEXT)}\n…` : text
  return (
    <pre
      data-embedded-resource={blockDisplayName(block)}
      className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground/90"
    >
      {boundedText}
    </pre>
  )
}

function InlineAudio({ block }: { block: ContentBlock }): React.JSX.Element | null {
  const src = inlineAudioUrl(block)
  if (!src) return null
  return (
    // biome-ignore lint/a11y/useMediaCaption: ACP audio blocks do not provide caption tracks.
    <audio
      aria-label={`Play ${blockDisplayName(block)}`}
      className="max-w-full"
      controls
      preload="metadata"
      src={src}
    />
  )
}

/** Render media blocks with safe inline previews and bounded embedded text. */
export function MediaBlocks({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element | null {
  const media = mediaBlocks(blocks)
  if (media.length === 0) return null
  const resources = media.filter((block) => block.type === 'resource')
  const attachments = media.filter(
    (block) =>
      (block.type !== 'audio' || !inlineAudioUrl(block)) &&
      !(block.type === 'resource' && typeof blockResource(block)?.text === 'string')
  )
  const audio = media.filter((block) => block.type === 'audio')
  return (
    <>
      {attachments.length > 0 && (
        <Attachments variant="grid" className="ml-0 w-fit py-0.5">
          {attachments.map((block, i) => (
            <MediaGridItem key={`${block.type}-${i}`} block={block} id={`${block.type}-${i}`} />
          ))}
        </Attachments>
      )}
      {audio.map((block, i) => (
        <InlineAudio key={`audio-${i}`} block={block} />
      ))}
      {resources.map((block, i) => (
        <ResourceText key={`resource-${i}`} block={block} />
      ))}
    </>
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
  // Fenced code copy/download come from ChatMarkdownCode (IconActionButton).
  code: false,
  table: { copy: true, download: true, fullscreen: true },
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true }
} as const

const STREAMDOWN_COMPONENTS = {
  code: ChatMarkdownCode,
  table: ChatMarkdownTable
} as const

// Opacity-only fade so streamed words reveal smoothly without the blur-filter
// jank of sd-blurIn. `animated` uses the styles.css keyframes imported in
// main.tsx; already-visible words get duration 0 (no re-animation).
const STREAMDOWN_ANIMATED = {
  animation: 'fadeIn',
  sep: 'word',
  duration: 200,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  stagger: 8
} as const

/**
 * Confirm external links, then hand off to the OS browser.
 *
 * `onLinkCheck` only decides whether to show the confirm UI (never opens).
 * Opening happens in the modal action so Streamdown's default `window.open`
 * path is not used and the dialog actually closes after confirm.
 */
function StreamdownLinkSafetyModal({
  isOpen,
  onClose,
  url
}: LinkSafetyModalProps): React.JSX.Element {
  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open external link?</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{url}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void openerApi.openUrlWithSystemBrowser(url)
              onClose()
            }}
          >
            Open
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  // Always take the confirm path; never open from the check callback.
  onLinkCheck: () => false,
  renderModal: (props) => <StreamdownLinkSafetyModal {...props} />
}

/** Agent reply rendered as streaming-safe, hardened markdown via Streamdown. */
function AgentProse({
  text,
  streaming,
  reduced,
  filePathContext
}: {
  text: string
  streaming: boolean
  reduced: boolean
  filePathContext?: FilePathResolutionContext
}): React.JSX.Element {
  const [externalUrl, setExternalUrl] = useState<string | null>(null)
  const filePathComponents = useMemo<Components | undefined>(() => {
    if (!filePathContext) return undefined

    const context = filePathContext
    return {
      a: ({ href, children, ...props }) => {
        const candidate = filePathFromHref(href)
        if (!candidate) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              {...props}
              onClick={(event) => {
                event.preventDefault()
                if (href) setExternalUrl(href)
              }}
              onAuxClick={(event) => {
                event.preventDefault()
              }}
            >
              {children}
            </a>
          )
        }

        return (
          <button
            type="button"
            className={cn(
              props.className,
              'cursor-pointer appearance-none text-left font-medium text-primary underline'
            )}
            title="Ctrl/Cmd-click to open in editor"
            onClick={(event) => {
              if (!event.ctrlKey && !event.metaKey) return
              event.preventDefault()
              void openFilePathFromTerminal(candidate, context)
                .then((result) => {
                  if (!result.ok) toast.error(result.message)
                })
                .catch((error: unknown) => {
                  void logFrontendError({
                    level: 'warn',
                    source: 'ChatMessage.filePathLink',
                    message: `Failed to open ${candidate}: ${String(error)}`
                  })
                  toast.error('Failed to open file from chat.')
                })
            }}
          >
            {children}
          </button>
        )
      }
    }
  }, [filePathContext])

  return (
    <div className="chat-streamdown min-w-0 text-sm leading-normal text-foreground">
      <Streamdown
        mode="streaming"
        isAnimating={streaming}
        caret="block"
        animated={reduced ? false : STREAMDOWN_ANIMATED}
        parseIncompleteMarkdown
        plugins={STREAMDOWN_PLUGINS}
        remarkPlugins={filePathContext ? FILE_PATH_REMARK_PLUGINS : undefined}
        controls={STREAMDOWN_CONTROLS}
        components={
          filePathComponents
            ? { ...STREAMDOWN_COMPONENTS, ...filePathComponents }
            : STREAMDOWN_COMPONENTS
        }
        lineNumbers={false}
        linkSafety={LINK_SAFETY}
        shikiTheme={['github-light', 'github-dark']}
      >
        {text}
      </Streamdown>
      {externalUrl && (
        <StreamdownLinkSafetyModal
          isOpen
          url={externalUrl}
          onClose={() => setExternalUrl(null)}
          onConfirm={() => setExternalUrl(null)}
        />
      )}
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
  /** Filesystem roots used for safe file-path links in agent prose. */
  filePathContext?: FilePathResolutionContext
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
  onRetry,
  filePathContext
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
                  <UserMessageText text={text} />
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
                // Copy a display-safe string: tokens become `(name)` so the
                // clipboard never carries private-use sentinels. Edit keeps the
                // raw token text so the composer re-seeds with chips inline.
                text={replaceSkillTokensInline(text)}
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

  const streaming = message.streaming && isLast
  const proseText = stripEmptyFences(text, streaming)
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
          {(proseText.length > 0 || streaming) && (
            <Bubble variant="ghost" className="w-fit max-w-full">
              <BubbleContent>
                <StaggerSection
                  delay={proseDelay}
                  align="start"
                  reduced={reduced}
                  animateEnter={animateEnter}
                >
                  {proseText.length > 0 && (
                    <AgentProse
                      text={proseText}
                      streaming={streaming}
                      reduced={reduced}
                      filePathContext={filePathContext}
                    />
                  )}
                  {streaming && proseText.length === 0 && (
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
