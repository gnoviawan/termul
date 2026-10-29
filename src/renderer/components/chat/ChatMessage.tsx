import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo } from 'react'

import { Attachment, AttachmentPreview, Attachments } from '@/components/ai-elements/attachments'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ContentBlock } from '@/lib/acp-api'
import {
  parseSelectionContextSegments,
  type SelectionContext,
  type SelectionContextSegment,
  serializeSelectionContexts
} from '@/lib/composer/selection-context'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import {
  isFolderTokenPath,
  parseCommandSegments,
  parseFileSegments,
  parseSkillSegments,
  type SkillSegment,
  sanitizeDisplayText
} from '@/lib/skill-tokens'
import { normalizePlanFenceBoundary, stripEmptyFences } from '@/lib/strip-empty-fences'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMedia } from './ChatMedia'
import { AgentProse } from './chat-agent-prose'
import { blockDisplayName, blockResource, blockToAttachmentData } from './chat-attachments'
import { chatMediaFromBlock } from './chat-media-source'
import { type BubbleAlign, staggerChild } from './chat-motion'
import { FileChip } from './FileChip'
import {
  logLongPressFallbackOnce,
  MessageActions,
  MessageActionsContextMenu,
  type MessageActionsMode,
  resolveMessageActionsMode,
  supportsLongPressMenu
} from './MessageActions'
import { SelectionContextChip } from './SelectionContextChip'
import { CommandChipLink, SkillChipLink } from './skill-file-links'

// The markdown renderer moved to `chat-agent-prose.tsx` to keep this file under
// the ~800-line limit. Re-exported so existing importers keep their paths.
export { AgentProse, TermulFilePathButton, TermulMarkdownMedia } from './chat-agent-prose'

/** Concatenate the text of all text blocks. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/**
 * Render a user message's text, swapping inline skill, file, AND command
 * tokens for read-only `SkillChip`/`CommandChip`/`FileChip` pills. Skill
 * (`\uE000..\uE001`), command (`\uE004..\uE005`), and file (`\uE006..\uE007`)
 * tokens use distinct sentinel pairs, so each walk leaves the other tokens in
 * its text segments. We parse skill segments first, then walk each text
 * segment for command tokens, then each command text segment for file tokens
 * — all pill types render at their correct positions when inline together. A
 * command token renders as a `CommandChip` (terminal icon, muted `/name`),
 * the same chip as the composer's `CommandPill`. Skill chips and skill-backed
 * command chips open their `SKILL.md` on click (see `skill-file-links`).
 * Plain text (no tokens)
 * renders verbatim with `whitespace-pre-wrap` to preserve the original
 * spacing. `MessageActions` still receives the sanitized copy text (tokens →
 * readable text) while edit keeps the raw token text so the composer
 * re-seeds with chips inline. Selection contexts (`\uE008..\uE009`) are
 * split out first and render as numbered `SelectionContextChip`s.
 */
function UserMessageText({ text }: { text: string }): React.JSX.Element {
  // Flatten: selection contexts → skill segments → command tokens → file tokens (innermost).
  type FlatSeg =
    | { kind: 'text'; text: string }
    | { kind: 'skill'; name: string }
    | { kind: 'file'; display: string; dir: boolean }
    | { kind: 'command'; name: string }
    | { kind: 'context'; context: SelectionContext; index: number }
  const flat: FlatSeg[] = []
  let hasPills = false
  let contextCount = 0
  const pushFileSegments = (segmentText: string): void => {
    const fileSegs = parseFileSegments(segmentText)
    if (fileSegs.length === 1 && fileSegs[0].kind === 'text') {
      // No file tokens in this text segment — keep it as one text span.
      flat.push({ kind: 'text', text: segmentText })
      return
    }
    for (const fseg of fileSegs) {
      if (fseg.kind === 'file') {
        flat.push({
          kind: 'file',
          display: fseg.display,
          dir: isFolderTokenPath(fseg.absPath)
        })
        hasPills = true
      } else {
        flat.push({ kind: 'text', text: fseg.text })
      }
    }
  }
  const segments = parseSelectionContextSegments(text).flatMap(
    (part): Array<SelectionContextSegment | SkillSegment> =>
      part.kind === 'context' ? [part] : parseSkillSegments(part.text)
  )
  for (const seg of segments) {
    if (seg.kind === 'context') {
      contextCount += 1
      flat.push({ kind: 'context', context: seg.context, index: contextCount })
      hasPills = true
      continue
    }
    if (seg.kind === 'skill') {
      flat.push({ kind: 'skill', name: seg.name })
      hasPills = true
      continue
    }
    // Text segment: walk for command tokens (\uE004..\uE005). Skill tokens
    // are invisible to this walk (already extracted above), so command
    // tokens land in the text segments alongside plain text and file tokens.
    const commandSegs = parseCommandSegments(seg.text)
    if (commandSegs.length === 1 && commandSegs[0].kind === 'text') {
      // No command tokens in this text segment — run the file walk on it.
      pushFileSegments(seg.text)
      continue
    }
    for (const cseg of commandSegs) {
      if (cseg.kind === 'command') {
        flat.push({ kind: 'command', name: cseg.name })
        hasPills = true
      } else {
        pushFileSegments(cseg.text)
      }
    }
  }
  return (
    <BubbleContent className="whitespace-pre-wrap">
      {!hasPills && flat.length === 0
        ? text
        : flat.map((seg, i) =>
            seg.kind === 'skill' ? (
              <SkillChipLink key={`skill-${i}`} name={seg.name} surface="bubble" />
            ) : seg.kind === 'command' ? (
              <CommandChipLink key={`command-${i}`} name={seg.name} surface="bubble" />
            ) : seg.kind === 'file' ? (
              <FileChip key={`file-${i}`} name={seg.display} kind={seg.dir ? 'dir' : 'file'} />
            ) : seg.kind === 'context' ? (
              <SelectionContextChip
                key={`context-${i}`}
                index={seg.index}
                context={seg.context}
                tabIndex={0}
              />
            ) : (
              <span key={`text-${i}`}>{seg.text}</span>
            )
          )}
    </BubbleContent>
  )
}

function FileCard({ block, id }: { block: ContentBlock; id: string }): React.JSX.Element {
  const data = useMemo(() => blockToAttachmentData(block, id), [block, id])
  return (
    <Attachment data={data} title={blockDisplayName(block)}>
      <AttachmentPreview />
    </Attachment>
  )
}

const MAX_INLINE_RESOURCE_TEXT = 32 * 1024

function ResourceText({ text, name }: { text: string; name: string }): React.JSX.Element {
  const boundedText =
    text.length > MAX_INLINE_RESOURCE_TEXT ? `${text.slice(0, MAX_INLINE_RESOURCE_TEXT)}\n…` : text
  return (
    <pre
      data-embedded-resource={name}
      className="scroller-thin max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-xs leading-relaxed text-foreground/90"
    >
      {boundedText}
    </pre>
  )
}

export function MediaBlocks({ blocks }: { blocks: ContentBlock[] }): React.JSX.Element | null {
  const items = blocks
    .filter((block) => block.type !== 'text')
    .map((block, i) => ({
      block,
      id: `${block.type}-${i}`,
      media: chatMediaFromBlock(block),
      text: blockResource(block)?.text
    }))
  if (items.length === 0) return null
  const tiles = items.filter(
    (item) => item.media?.kind === 'image' || (!item.media && typeof item.text !== 'string')
  )
  return (
    <>
      {tiles.length > 0 && (
        <Attachments variant="grid" className="ml-0 w-fit py-0.5">
          {tiles.map(({ block, id, media }) =>
            media ? (
              <ChatMedia
                key={id}
                media={media}
                layout="tile"
                fallback={<FileCard block={block} id={id} />}
              />
            ) : (
              <FileCard key={id} block={block} id={id} />
            )
          )}
        </Attachments>
      )}
      {items.flatMap(({ id, media }) =>
        media && media.kind !== 'image' ? [<ChatMedia key={id} media={media} />] : []
      )}
      {items.map(({ block, id, text }) =>
        typeof text === 'string' ? (
          <ResourceText key={id} text={text} name={blockDisplayName(block)} />
        ) : null
      )}
    </>
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

/** The same inset focus ring as `ToolCallCard`, for a focusable message. */
const MOBILE_ACTIONS_RING_CLASS =
  'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

/**
 * Classes for a message that owns mobile actions: the focus ring in every
 * mobile mode, plus no native text selection on coarse pointers only in
 * `focus-reveal`, where the long-press belongs to the menu (see
 * `MessageActionsContextMenu`). In `visible-fallback` long-press cannot work,
 * so selection stays and the always-visible row carries Copy.
 */
function mobileActionsMessageClass(mode: MessageActionsMode): string | undefined {
  if (mode === 'desktop') return undefined
  return mode === 'focus-reveal'
    ? `${MOBILE_ACTIONS_RING_CLASS} pointer-coarse:select-none`
    : MOBILE_ACTIONS_RING_CLASS
}

/**
 * Touch / pen `pointerdown` on a message that owns the long-press menu: cancel
 * the default so the app-root `GlobalContextMenu` (Copy / Cut / Paste / Select
 * All) does not arm its own 700ms timer. Radix composes the root trigger's
 * handler behind a `defaultPrevented` check, and the deeper message trigger has
 * already armed by the time the event reaches this wrapper. The event is NOT
 * stopped: `ChatRoute` and Radix outside-pointer detection need it to bubble.
 *
 * Events from portaled descendants (link-safety dialog, image lightbox) bubble
 * here through React but are not on the message: leave their default alone.
 */
function suppressGlobalLongPress(event: React.PointerEvent<HTMLDivElement>): void {
  if (event.pointerType === 'mouse') return
  if (!event.currentTarget.contains(event.target as Node)) return
  event.preventDefault()
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
  const isMobileShell = useMobileWebShell()

  const isUser = message.role === 'user'
  const text = blocksToText(message.blocks)
  const hasMedia = message.blocks.some((block) => block.type !== 'text')
  // Only messages that render `MessageActions` take part in the mobile actions
  // model: every user message, and an agent message only at its settled turn
  // tail. Messages inside `TurnActivity` never qualify.
  const hasActions = isUser || (!message.streaming && isTurnTail)
  const actionsMode: MessageActionsMode = hasActions
    ? resolveMessageActionsMode(isMobileShell, supportsLongPressMenu())
    : 'desktop'
  const mobileActions = actionsMode !== 'desktop'
  const mobileActionsClass = mobileActionsMessageClass(actionsMode)
  // On the mobile shell every message keeps the same menu wrapper (inert unless
  // it has actions), so a message that gains or loses actions as its stream
  // settles or the turn tail moves does not remount its subtree.
  const menuWrapped = isMobileShell
  const actionsReveal = actionsMode === 'focus-reveal' ? 'focus' : 'hover'
  const actionsMenuId = `message-actions-menu:${message.id}`
  useEffect(() => {
    if (actionsMode === 'visible-fallback') logLongPressFallbackOnce()
  }, [actionsMode])
  let staggerStep = 0
  const nextDelay = (): number => {
    const delay = staggerStep * 0.08
    staggerStep += 1
    return delay
  }

  if (isUser) {
    // Copy a display-safe string: skill/file tokens become `(name)` and command
    // tokens become `/name` so the clipboard never carries private-use
    // sentinels. Edit keeps the raw token text so the composer re-seeds with
    // chips inline (command pill included). The row and the mobile menu share
    // both.
    const copyTextForActions = sanitizeDisplayText(serializeSelectionContexts(text))
    const editForActions = onEdit && text.length > 0 ? () => onEdit(text) : undefined
    const userMessage = (
      <Message
        align="end"
        className={cn('py-2', mobileActionsClass)}
        // On the mobile shell a message with actions is focusable so keyboard and
        // switch users reach its focus-revealed row. Biome does not flag tabIndex
        // on this component, so no suppression is needed.
        tabIndex={mobileActions ? 0 : undefined}
      >
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
              <Bubble
                variant="tinted"
                align="end"
                className="max-w-full"
                data-selection-context-source=""
              >
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
              text={copyTextForActions}
              align="end"
              pinned={actionsPinned}
              reveal={actionsReveal}
              onEdit={editForActions}
            />
          </StaggerSection>
        </MessageContent>
      </Message>
    )

    return (
      <div className="w-full" onPointerDown={mobileActions ? suppressGlobalLongPress : undefined}>
        {menuWrapped ? (
          <MessageActionsContextMenu
            overlayId={actionsMenuId}
            text={copyTextForActions}
            onEdit={editForActions}
            disabled={!mobileActions}
          >
            {userMessage}
          </MessageActionsContextMenu>
        ) : (
          userMessage
        )}
      </div>
    )
  }

  const streaming = message.streaming && isLast
  const proseText = normalizePlanFenceBoundary(stripEmptyFences(text, streaming))
  const proseDelay = nextDelay()
  const mediaDelay = hasMedia ? nextDelay() : null
  const actionsDelay = nextDelay()
  const agentCopyText = turnText ?? text

  const agentMessage = (
    <Message
      align="start"
      className={cn(showHeader ? 'py-2' : 'pb-2', mobileActionsClass)}
      // On the mobile shell a message with actions is focusable so keyboard and
      // switch users reach its focus-revealed row. Biome does not flag tabIndex
      // on this component, so no suppression is needed.
      tabIndex={mobileActions ? 0 : undefined}
    >
      <MessageContent className="min-w-0 flex-1">
        {/* Skip the ghost bubble entirely for attachment-only assistant turns
            so they don't render a blank shell above the media grid. The
            streaming caret still needs a bubble to live in while the turn is
            in progress, even before any text has arrived. */}
        {(proseText.length > 0 || streaming) && (
          <Bubble variant="ghost" className="w-full" data-selection-context-source="">
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
                    linkScope={message.id}
                  />
                )}
                {streaming && proseText.length === 0 && (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-0.5 animate-caret-blink bg-foreground align-middle motion-reduce:animate-none motion-reduce:opacity-100"
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
        {hasActions && (
          <StaggerSection
            delay={actionsDelay}
            align="start"
            reduced={reduced}
            animateEnter={animateEnter}
          >
            <MessageActions
              text={agentCopyText}
              align="start"
              pinned={actionsPinned}
              reveal={actionsReveal}
              onRetry={onRetry}
            />
          </StaggerSection>
        )}
      </MessageContent>
    </Message>
  )

  return (
    <div className="w-full" onPointerDown={mobileActions ? suppressGlobalLongPress : undefined}>
      {menuWrapped ? (
        <MessageActionsContextMenu
          overlayId={actionsMenuId}
          text={agentCopyText}
          onRetry={onRetry}
          disabled={!mobileActions}
        >
          {agentMessage}
        </MessageActionsContextMenu>
      ) : (
        agentMessage
      )}
    </div>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
