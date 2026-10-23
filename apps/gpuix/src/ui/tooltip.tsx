/**
 * Radix Tooltip on GPUIX anchored layers: Provider `delayDuration` (default
 * 700ms) and `skipDelayDuration` (300ms), open on hover after the delay or at
 * once on focus, close on leave, press, blur and Escape.
 */
import type { PublicInstance } from '@gpuix/react'
import {
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'
import {
  type Align,
  Floating,
  OverlayContext,
  type Side,
  useOverlay,
  useOverlayState
} from './internal/overlay'
import { TriggerBase, type TriggerProps } from './internal/trigger'

interface ProviderValue {
  delayDuration: number
  skipDelayDuration: number
  disableHoverableContent: boolean
  lastClosedAt: { current: number }
}

const ProviderContext = createContext<ProviderValue>({
  delayDuration: 700,
  skipDelayDuration: 300,
  disableHoverableContent: false,
  lastClosedAt: { current: Number.NEGATIVE_INFINITY }
})

function TooltipProvider({
  children,
  delayDuration = 700,
  skipDelayDuration = 300,
  disableHoverableContent = false
}: {
  children: ReactNode
  delayDuration?: number
  skipDelayDuration?: number
  disableHoverableContent?: boolean
}) {
  const lastClosedAt = useRef(Number.NEGATIVE_INFINITY)
  const value = useMemo(
    () => ({ delayDuration, skipDelayDuration, disableHoverableContent, lastClosedAt }),
    [delayDuration, skipDelayDuration, disableHoverableContent]
  )
  return <ProviderContext.Provider value={value}>{children}</ProviderContext.Provider>
}

interface Timing {
  scheduleOpen(): void
  scheduleClose(): void
  cancelClose(): void
  openNow(): void
  close(): void
  hoverable: boolean
}

const TimingContext = createContext<Timing | null>(null)

/** Pointer leaving the trigger for the content within this grace keeps the tooltip open. */
const HOVER_GRACE_MS = 80

function Tooltip({
  children,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  disableHoverableContent
}: {
  children: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  disableHoverableContent?: boolean
}) {
  const provider = useContext(ProviderContext)
  const overlay = useOverlayState({ open, defaultOpen, onOpenChange })
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverable = !(disableHoverableContent ?? provider.disableHoverableContent)

  const timing = useMemo<Timing>(() => {
    const clear = () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    }
    const set = (next: boolean) => {
      clear()
      if (!next && overlay.openRef.current) provider.lastClosedAt.current = Date.now()
      overlay.setOpen(next, 'pointer')
    }
    return {
      hoverable,
      openNow: () => set(true),
      close: () => set(false),
      cancelClose: () => clearTimeout(closeTimer.current),
      scheduleOpen() {
        clearTimeout(closeTimer.current)
        const skip = Date.now() - provider.lastClosedAt.current <= provider.skipDelayDuration
        const delay = skip ? 0 : (delayDuration ?? provider.delayDuration)
        if (delay <= 0) set(true)
        else openTimer.current = setTimeout(() => set(true), delay)
      },
      scheduleClose() {
        clearTimeout(openTimer.current)
        if (!hoverable) set(false)
        else closeTimer.current = setTimeout(() => set(false), HOVER_GRACE_MS)
      }
    }
  }, [overlay, provider, delayDuration, hoverable])

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    []
  )

  return (
    <OverlayContext.Provider value={overlay}>
      <TimingContext.Provider value={timing}>{children}</TimingContext.Provider>
    </OverlayContext.Provider>
  )
}

function useTiming(): Timing {
  const timing = useContext(TimingContext)
  if (!timing) throw new Error('Tooltip parts must be inside Tooltip')
  return timing
}

const TooltipTrigger = forwardRef<PublicInstance, TriggerProps>(function TooltipTrigger(
  { onMouseEnter, onMouseLeave, onMouseDown, onFocus, onBlur, ...props },
  ref
) {
  const overlay = useOverlay('TooltipTrigger')
  const timing = useTiming()
  return (
    <TriggerBase
      ref={ref}
      overlay={overlay}
      {...props}
      onMouseEnter={(event) => {
        onMouseEnter?.(event)
        timing.scheduleOpen()
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event)
        timing.scheduleClose()
      }}
      onMouseDown={(event) => {
        onMouseDown?.(event)
        timing.close()
      }}
      onFocus={(event) => {
        onFocus?.(event)
        timing.openNow()
      }}
      onBlur={(event) => {
        onBlur?.(event)
        timing.close()
      }}
    />
  )
})

export interface TooltipContentProps extends HostProps {
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  avoidCollisions?: boolean
}

const TooltipContent = forwardRef<PublicInstance, TooltipContentProps>(function TooltipContent(
  {
    className,
    side = 'top',
    align = 'center',
    sideOffset = 4,
    alignOffset,
    avoidCollisions,
    ...props
  },
  ref
) {
  const overlay = useOverlay('TooltipContent')
  const timing = useTiming()
  if (!overlay.open) return null
  return (
    <Floating
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      avoidCollisions={avoidCollisions}
      priority={2}
      returnFocus={false}
      onDismiss={timing.close}
    >
      <Box
        ref={ref}
        role="tooltip"
        data-state="delayed-open"
        data-side={side}
        {...props}
        onMouseEnter={() => {
          if (timing.hoverable) timing.cancelClose()
        }}
        onMouseLeave={timing.scheduleClose}
        className={cn(
          'z-50 rounded-lg border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md',
          'animate-tooltip-in',
          className
        )}
      />
    </Floating>
  )
})

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
