/**
 * Radix Popover on GPUIX anchored layers: the trigger toggles it, Escape and a
 * press outside close it, focus moves into the content and back to the trigger.
 */
import type { PublicInstance } from '@gpuix/react'
import { forwardRef, type ReactNode, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps, mergeRefs } from './internal/host'
import {
  type Align,
  Floating,
  OverlayContext,
  type Side,
  useFocusFirstTabbable,
  useLayer,
  useOverlay,
  useOverlayState
} from './internal/overlay'
import { TriggerBase, type TriggerProps } from './internal/trigger'

function Popover({
  children,
  open,
  defaultOpen,
  onOpenChange
}: {
  children: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
}) {
  const overlay = useOverlayState({ open, defaultOpen, onOpenChange })
  return <OverlayContext.Provider value={overlay}>{children}</OverlayContext.Provider>
}

const PopoverTrigger = forwardRef<PublicInstance, TriggerProps>(function PopoverTrigger(
  { onClick, ...props },
  ref
) {
  const overlay = useOverlay('PopoverTrigger')
  return (
    <TriggerBase
      ref={ref}
      overlay={overlay}
      aria-haspopup="dialog"
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) overlay.setOpen(!overlay.openRef.current, 'pointer')
      }}
    />
  )
})

export interface DismissEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

const dismissEvent = (): DismissEvent => {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    }
  }
  return event
}

export interface PopoverContentProps extends HostProps {
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  avoidCollisions?: boolean
  forceMount?: true
  onOpenAutoFocus?: (event: DismissEvent) => void
  onCloseAutoFocus?: (event: DismissEvent) => void
  onEscapeKeyDown?: (event: DismissEvent) => void
  onPointerDownOutside?: (event: DismissEvent) => void
  onInteractOutside?: (event: DismissEvent) => void
}

/** Shared by Popover and AnimatedMenuContent: the anchored surface with Radix dismissal. */
export const PopoverSurface = forwardRef<
  PublicInstance,
  PopoverContentProps & { surfaceClassName: string }
>(function PopoverSurface(
  {
    surfaceClassName,
    side = 'bottom',
    align = 'center',
    sideOffset = 4,
    alignOffset,
    avoidCollisions,
    forceMount,
    onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    onEscapeKeyDown,
    onPointerDownOutside,
    onInteractOutside,
    ...props
  },
  ref
) {
  const overlay = useOverlay('PopoverContent')
  const content = useRef<PublicInstance | null>(null)
  const { node, onMouseDownOutside } = useLayer(overlay, content, () => {
    const event = dismissEvent()
    onPointerDownOutside?.(event)
    onInteractOutside?.(event)
    if (!event.defaultPrevented) overlay.setOpen(false)
  })
  const [autoFocus, setAutoFocus] = useState(false)
  useFocusFirstTabbable(content, overlay.open && autoFocus)
  if (!overlay.open && !forceMount) return null
  return (
    <Floating
      layer={node}
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      avoidCollisions={avoidCollisions}
      onDismiss={() => {
        const event = dismissEvent()
        onEscapeKeyDown?.(event)
        if (!event.defaultPrevented) overlay.setOpen(false)
      }}
      focusContent={() => {
        const event = dismissEvent()
        onOpenAutoFocus?.(event)
        if (event.defaultPrevented) return null
        setAutoFocus(true)
        return content.current?.id ?? null
      }}
    >
      <Box
        ref={mergeRefs(ref, content)}
        role="dialog"
        tabIndex={-1}
        data-state={overlay.open ? 'open' : 'closed'}
        data-side={side}
        data-align={align}
        {...props}
        className={surfaceClassName}
        native={{ onMouseDownOutside }}
      />
    </Floating>
  )
})

const PopoverContent = forwardRef<PublicInstance, PopoverContentProps>(function PopoverContent(
  { className, ...props },
  ref
) {
  return (
    <PopoverSurface
      ref={ref}
      {...props}
      surfaceClassName={cn(
        'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className
      )}
    />
  )
})

export { Popover, PopoverContent, PopoverTrigger }
