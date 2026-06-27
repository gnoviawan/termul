import { ArrowDown } from 'lucide-react'
import * as React from 'react'

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
  const pinnedRef = React.useRef(pinned)
  pinnedRef.current = pinned

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
    () => ({ registerViewport: setViewportEl, pinned, showButton, scrollToEnd }),
    [pinned, showButton, scrollToEnd]
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
  const { showButton, scrollToEnd } = useMessageScroller()
  return (
    <Button
      data-slot="message-scroller-button"
      type="button"
      variant="secondary"
      size="icon-sm"
      aria-hidden={!showButton}
      tabIndex={showButton ? 0 : -1}
      onClick={() => scrollToEnd('smooth')}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-background text-foreground shadow-md transition-[opacity,transform] duration-200 hover:bg-muted',
        showButton ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        className
      )}
      {...props}
    >
      <ArrowDown />
      <span className="sr-only">Scroll to latest</span>
    </Button>
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
