import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowDown } from 'lucide-react'
import * as React from 'react'

import { CHAT_SPRING } from '@/components/chat/chat-motion'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Native (React 18-safe) message scroller. Mirrors the shadcn MessageScroller
 * component API without the `@shadcn/react` headless engine (which requires
 * React 19). Behavior: auto-follow the live edge only while the reader is
 * pinned to the bottom; surface a jump-to-latest control otherwise.
 */

const BOTTOM_THRESHOLD_PX = 48

interface MessageScrollerContextValue {
  registerViewport: (el: HTMLDivElement | null) => void
  pinned: boolean
  showButton: boolean
  /** Number of items added while the reader was scrolled away from the live edge. */
  newCount: number
  /** Report the current item count so unread can be derived. */
  setItemCount: (n: number) => void
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

const MessageScrollerContext = React.createContext<MessageScrollerContextValue | null>(null)

function useMessageScroller(): MessageScrollerContextValue {
  const ctx = React.useContext(MessageScrollerContext)
  if (!ctx) {
    throw new Error('useMessageScroller must be used within <MessageScrollerProvider>')
  }
  return ctx
}

function MessageScrollerProvider({
  autoScroll = true,
  children
}: {
  autoScroll?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [viewportEl, setViewportEl] = React.useState<HTMLDivElement | null>(null)
  const [pinned, setPinned] = React.useState(true)
  const [showButton, setShowButton] = React.useState(false)
  const [itemCount, setItemCount] = React.useState(0)
  const [seenCount, setSeenCount] = React.useState(0)
  const pinnedRef = React.useRef(pinned)
  pinnedRef.current = pinned

  // While pinned to the live edge, everything is "seen". Unread is whatever
  // arrived since the reader last sat at the bottom.
  React.useEffect(() => {
    if (pinned) setSeenCount(itemCount)
  }, [pinned, itemCount])
  const newCount = pinned ? 0 : Math.max(0, itemCount - seenCount)

  const scrollToEnd = React.useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      if (!viewportEl) return
      viewportEl.scrollTo({ top: viewportEl.scrollHeight, behavior })
      setPinned(true)
      setShowButton(false)
    },
    [viewportEl]
  )

  React.useEffect(() => {
    if (!viewportEl) return
    const update = (): void => {
      const distance = viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight
      const isPinned = distance <= BOTTOM_THRESHOLD_PX
      const overflowing = viewportEl.scrollHeight - viewportEl.clientHeight > BOTTOM_THRESHOLD_PX
      setPinned(isPinned)
      setShowButton(overflowing && !isPinned)
    }

    const onScroll = (): void => update()
    viewportEl.addEventListener('scroll', onScroll, { passive: true })

    const follow = (): void => {
      if (autoScroll && pinnedRef.current) {
        viewportEl.scrollTop = viewportEl.scrollHeight
      }
      update()
    }

    const content = viewportEl.firstElementChild
    const ro = new ResizeObserver(follow)
    ro.observe(viewportEl)
    if (content) ro.observe(content)

    update()

    return () => {
      viewportEl.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [viewportEl, autoScroll])

  const value = React.useMemo<MessageScrollerContextValue>(
    () => ({
      registerViewport: setViewportEl,
      pinned,
      showButton,
      newCount,
      setItemCount,
      scrollToEnd
    }),
    [pinned, showButton, newCount, scrollToEnd]
  )

  return <MessageScrollerContext.Provider value={value}>{children}</MessageScrollerContext.Provider>
}

function MessageScroller({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  const { registerViewport } = useMessageScroller()
  return (
    <div
      ref={registerViewport}
      data-slot="message-scroller-viewport"
      className={cn('size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain', className)}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="message-scroller-content"
      role="log"
      aria-relevant="additions"
      aria-live="polite"
      className={cn('flex min-h-full flex-col', className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  messageId,
  ...props
}: React.ComponentProps<'div'> & {
  scrollAnchor?: boolean
  messageId?: string
}): React.JSX.Element {
  return (
    <div
      data-slot="message-scroller-item"
      data-scroll-anchor={scrollAnchor || undefined}
      data-message-id={messageId}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  )
}

function MessageScrollerButton({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'children'>): React.JSX.Element {
  const { showButton, newCount, scrollToEnd } = useMessageScroller()
  const reduced = useReducedMotion() ?? false
  const hasNew = newCount > 0
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2">
      <AnimatePresence>
        {showButton && (
          <motion.div
            key="jump-to-latest"
            className="pointer-events-auto relative"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.6, y: 8 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.8, y: 8 }}
            transition={CHAT_SPRING}
          >
            {hasNew && (
              <span className="pointer-events-none absolute inset-0 animate-ping rounded-full bg-primary/30 motion-reduce:animate-none" />
            )}
            {hasNew && (
              <span className="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-primary px-1.5 text-3xs font-semibold tabular-nums text-primary-foreground shadow-sm">
                {newCount > 99 ? '99+' : newCount}
              </span>
            )}
            <Button
              data-slot="message-scroller-button"
              type="button"
              variant="secondary"
              size="icon-sm"
              onClick={() => scrollToEnd('smooth')}
              className={cn(
                'relative rounded-full border border-border bg-background text-foreground shadow-md hover:bg-muted',
                hasNew && 'border-primary/50',
                className
              )}
              {...props}
            >
              <ArrowDown />
              <span className="sr-only">
                {hasNew ? `Scroll to latest (${newCount} new)` : 'Scroll to latest'}
              </span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller
}
