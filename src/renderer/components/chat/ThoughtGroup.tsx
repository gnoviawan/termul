import { motion, useReducedMotion } from 'framer-motion'
import { ArrowDown, Brain, ChevronRight, Maximize2, Minimize2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { ShimmerText } from '@/components/ui/shimmer-text'
import type { ContentBlock } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store'
import { CHEVRON_TRANSITION } from './chat-motion'

/** Distance from the bottom (px) within which the reader counts as "pinned"
 * to the live edge. Mirrors MessageScroller's BOTTOM_THRESHOLD_PX. */
const BOTTOM_THRESHOLD_PX = 48

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function thoughtTexts(messages: ChatMessage[]): string {
  return messages
    .map((m) => blocksToText(m.blocks))
    .filter((t) => t.length > 0)
    .join('\n\n')
}

interface ThoughtGroupProps {
  messages: ChatMessage[]
  /** True when this group is the last timeline item (nothing after it yet). */
  isLiveTail: boolean
}

/**
 * Live-edge auto-scroll for the thinking content box. Mirrors the
 * MessageScroller pattern: track whether the reader is pinned to the bottom,
 * and while streaming + collapsed + pinned, follow the live edge as content
 * grows (via a ResizeObserver). When the reader scrolls away, stop following
 * and surface a "jump to latest" affordance the caller renders.
 *
 * The scroll element is captured via a state-backed callback ref (not a plain
 * ref): the box only mounts once the collapsible opens, so a plain ref would be
 * null on the first effect run and never re-attach. The state update when the
 * element mounts re-triggers the effect so the listener/observer attach.
 */
function useThinkingAutoScroll(opts: { enabled: boolean; expanded: boolean }): {
  refCallback: (el: HTMLDivElement | null) => void
  showJumpButton: boolean
  /** True when collapsed content exceeds the max-height box (More is useful). */
  overflows: boolean
  scrollToBottom: (behavior: ScrollBehavior) => void
} {
  const { enabled, expanded } = opts
  // Follow is only meaningful in collapsed mode (expanded removes max-height,
  // so there is no inner scroll to follow).
  const active = enabled && !expanded
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(true)
  const [showJumpButton, setShowJumpButton] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const pinnedRef = useRef(pinned)
  // Keep the ref's latest committed value without mutating it during render
  // (React can replay/discard render work). Written in a passive effect below.
  useEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  const refCallback = useCallback((node: HTMLDivElement | null) => {
    setEl(node)
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      if (!el) return
      el.scrollTo({ top: el.scrollHeight, behavior })
      setPinned(true)
      setShowJumpButton(false)
    },
    [el]
  )

  // Reset to pinned only when a genuine new streaming stretch begins
  // (enabled false -> true), not on every `expanded` toggle. A reader who
  // scrolled away, expanded to read earlier content, then collapsed mid-stream
  // should NOT be silently re-pinned to the bottom.
  const prevEnabledRef = useRef(enabled)
  useEffect(() => {
    if (enabled && !prevEnabledRef.current) {
      setPinned(true)
      setShowJumpButton(false)
    }
    prevEnabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    if (!el) return

    const update = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const isPinned = distance <= BOTTOM_THRESHOLD_PX
      // Any clipped content (not just past the jump threshold) warrants More.
      const contentOverflows = el.scrollHeight > el.clientHeight + 1
      const overflowing = el.scrollHeight - el.clientHeight > BOTTOM_THRESHOLD_PX
      setPinned(isPinned)
      // Expanded removes max-height so scrollHeight ≈ clientHeight — keep the
      // last collapsed measurement so Less stays available until the user
      // collapses (or content shrinks while collapsed).
      if (!expanded) setOverflows(contentOverflows)
      // Only surface the jump button while actively streaming + collapsed;
      // otherwise the box is static and a jump affordance is noise.
      setShowJumpButton(active && overflowing && !isPinned)
    }

    const onScroll = (): void => update()

    el.addEventListener('scroll', onScroll, { passive: true })

    const follow = (): void => {
      if (active && pinnedRef.current) {
        el.scrollTop = el.scrollHeight
      }
      update()
    }

    const ro = new ResizeObserver(follow)
    ro.observe(el)
    // Observe the inner content element too. The scroll container stops growing
    // once it hits max-h-[200px], so observing only the container would miss
    // growth from streamed text appended after the box is full. The inner
    // wrapper keeps growing with the text and fires the observer.
    const content = el.firstElementChild
    if (content) ro.observe(content)

    follow()

    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [el, active, expanded])

  return { refCallback, showJumpButton, overflows, scrollToBottom }
}

/**
 * Consolidated agent reasoning block — auto-opens while streaming at the live
 * tail, collapses once tools or reply follow (AI SDK Reasoning pattern).
 *
 * The thinking content is rendered inside a scrollable box with a max height.
 * When the content exceeds the box, the reader can scroll within it. While
 * streaming, the box follows its own live edge (auto-scrolls to bottom) as long
 * as the reader is pinned to the bottom — the same behavior as the main chat
 * scroll. Scrolling away stops the follow and surfaces a "jump to latest"
 * affordance. An "Expand all" (More) toggle removes the max-height limit so the
 * full content is visible without scrolling — only when the collapsed box
 * actually clips content. Short thoughts skip the affordance entirely.
 * Default is minimized (collapsed).
 */
export function ThoughtGroup({ messages, isLiveTail }: ThoughtGroupProps): React.JSX.Element {
  const { t } = useTranslation('chat')
  const reduced = useReducedMotion() ?? false
  const isStreaming = isLiveTail && messages.some((m) => m.streaming)
  const text = thoughtTexts(messages)
  const lines = text.split('\n').filter((l) => l.trim().length > 0).length

  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const userOverride = useRef(false)

  const { refCallback, showJumpButton, overflows, scrollToBottom } = useThinkingAutoScroll({
    enabled: isStreaming,
    expanded
  })
  const showExpandToggle = expanded || overflows

  useEffect(() => {
    if (userOverride.current) return
    setOpen(isStreaming)
  }, [isStreaming])

  // Reset expanded state when collapsing
  useEffect(() => {
    if (!open) setExpanded(false)
  }, [open])

  const handleOpenChange = (next: boolean): void => {
    userOverride.current = true
    setOpen(next)
  }

  const handleExpandToggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setExpanded((prev) => !prev)
  }

  const handleJumpToLatest = (e: React.MouseEvent): void => {
    e.stopPropagation()
    scrollToBottom(reduced ? 'auto' : 'smooth')
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="py-2">
      <CollapsibleTrigger
        data-press-feedback="off"
        className="flex min-h-10 w-full cursor-pointer items-center gap-1 text-left"
      >
        <Marker
          variant="default"
          className="inline-flex min-w-0 flex-1 font-medium text-muted-foreground"
        >
          <MarkerIcon>
            <Brain />
          </MarkerIcon>
          <MarkerContent className="min-w-0 flex-1">
            {isStreaming ? <ShimmerText text={t('thinking.thinking')} /> : t('thinking.thought')}
            {lines > 0 ? (
              <>
                {' · '}
                <span className="tabular-nums font-normal">
                  {t('thinking.lines', { count: lines })}
                </span>
              </>
            ) : null}
          </MarkerContent>
        </Marker>
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
        >
          <ChevronRight size={13} />
        </motion.span>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open}>
          <div className="mt-1.5 flex flex-col pl-3">
            <div className="relative">
              <div
                ref={refCallback}
                className={cn(
                  'overflow-y-auto whitespace-pre-wrap break-words text-xs italic text-muted-foreground',
                  !expanded && 'max-h-[200px]'
                )}
              >
                <div className="min-w-0">{text}</div>
              </div>
              {showJumpButton ? (
                <button
                  type="button"
                  onClick={handleJumpToLatest}
                  className="absolute bottom-1.5 right-1.5 z-10 inline-flex size-11 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:text-foreground"
                  aria-label={t('thinking.jump')}
                >
                  <ArrowDown size={13} />
                  <span className="sr-only">{t('thinking.jumpShort')}</span>
                </button>
              ) : null}
            </div>
            {showExpandToggle ? (
              <button
                type="button"
                onClick={handleExpandToggle}
                className="mt-1 flex cursor-pointer items-center gap-1 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
                aria-label={expanded ? t('thinking.collapse') : t('thinking.expand')}
              >
                {expanded ? (
                  <>
                    <Minimize2 size={12} />
                    <span>{t('thinking.less')}</span>
                  </>
                ) : (
                  <>
                    <Maximize2 size={12} />
                    <span>{t('thinking.more')}</span>
                  </>
                )}
              </button>
            ) : null}
          </div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}
