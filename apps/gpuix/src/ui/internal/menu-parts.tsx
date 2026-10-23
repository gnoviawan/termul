/**
 * The parts DropdownMenu and ContextMenu share (Radix Menu): content, items,
 * checkbox and radio items, labels, separators, shortcuts and sub-menus. Each
 * public module passes its own class strings, as the web wrappers do.
 */
import type { PublicInstance } from '@gpuix/react'
import {
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef
} from 'react'
import { cn } from '@/lib/utils'
import { Check, ChevronRight } from '../../icons'
import { Box, type HostProps, mergeRefs } from './host'
import {
  MenuContext,
  type MenuSelectEvent,
  selectEvent,
  textOf,
  useMenu,
  useMenuItem,
  useMenuModel
} from './menu'
import {
  type Align,
  Floating,
  OverlayContext,
  type OverlayState,
  type Side,
  useLayer,
  useOverlay,
  useOverlayState
} from './overlay'
import { useTriggerRef } from './trigger'

/** Closes the whole menu tree, so a sub-menu item's selection closes its root too. */
const RootCloseContext = createContext<() => void>(() => {})

export interface MenuRootProps {
  children?: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
}

export function MenuRoot({ children, open, defaultOpen, onOpenChange }: MenuRootProps) {
  const overlay = useOverlayState({ open, defaultOpen, onOpenChange })
  return (
    <OverlayContext.Provider value={overlay}>
      <RootCloseContext.Provider value={() => overlay.setOpen(false)}>
        {children}
      </RootCloseContext.Provider>
    </OverlayContext.Provider>
  )
}

export interface DismissableEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

function dismissable(): DismissableEvent {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    }
  }
  return event
}

export interface MenuContentProps extends HostProps {
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  avoidCollisions?: boolean
  loop?: boolean
  onEscapeKeyDown?: (event: DismissableEvent) => void
  onPointerDownOutside?: (event: DismissableEvent) => void
  onInteractOutside?: (event: DismissableEvent) => void
  onCloseAutoFocus?: (event: DismissableEvent) => void
}

/** The menu surface: anchored layer, keyboard model, outside-press and Escape dismissal. */
export const MenuContentBase = forwardRef<
  PublicInstance,
  MenuContentProps & { position?: { x: number; y: number }; priority?: number; sub?: boolean }
>(function MenuContentBase(
  {
    side = 'bottom',
    align = 'center',
    sideOffset = 0,
    alignOffset,
    avoidCollisions,
    loop: _loop,
    onEscapeKeyDown,
    onPointerDownOutside,
    onInteractOutside,
    onCloseAutoFocus: _onCloseAutoFocus,
    position,
    priority,
    sub = false,
    onKeyDown,
    ...props
  },
  ref
) {
  const overlay = useOverlay('MenuContent')
  if (!overlay.open) return null
  return (
    <OpenMenu
      ref={ref}
      overlay={overlay}
      floating={{ side, align, sideOffset, alignOffset, avoidCollisions, position, priority }}
      sub={sub}
      onEscapeKeyDown={onEscapeKeyDown}
      onOutside={(event) => {
        onPointerDownOutside?.(event)
        onInteractOutside?.(event)
      }}
      onKeyDown={onKeyDown}
      host={props}
    />
  )
})

const OpenMenu = forwardRef<
  PublicInstance,
  {
    overlay: OverlayState
    floating: {
      side: Side
      align: Align
      sideOffset: number
      alignOffset?: number
      avoidCollisions?: boolean
      position?: { x: number; y: number }
      priority?: number
    }
    sub: boolean
    onEscapeKeyDown?: (event: DismissableEvent) => void
    onOutside(event: DismissableEvent): void
    onKeyDown?: HostProps['onKeyDown']
    host: HostProps
  }
>(function OpenMenu({ overlay, floating, sub, onEscapeKeyDown, onOutside, onKeyDown, host }, ref) {
  const menu = useMenuModel()
  const content = useRef<PublicInstance | null>(null)
  const closeRoot = useContext(RootCloseContext)
  const { node, onMouseDownOutside } = useLayer(overlay, content, () => {
    const event = dismissable()
    onOutside(event)
    if (!event.defaultPrevented) (sub ? overlay.setOpen : closeRoot)(false)
  })
  const opened = useRef(overlay.openReason)
  // Opened from the keyboard, Radix focuses the first item; from the pointer, none.
  useLayoutEffect(() => {
    if (opened.current === 'keyboard') menu.highlightFirst()
  }, [menu.highlightFirst])
  return (
    <Floating
      {...floating}
      layer={node}
      onDismiss={() => {
        const event = dismissable()
        onEscapeKeyDown?.(event)
        if (!event.defaultPrevented) overlay.setOpen(false)
      }}
      focusContent={() => content.current?.id ?? null}
    >
      <MenuContext.Provider value={menu}>
        <Box
          ref={mergeRefs(ref, content)}
          role="menu"
          tabIndex={-1}
          data-state="open"
          data-side={floating.side}
          {...host}
          native={{ onMouseDownOutside }}
          onMouseLeave={() => menu.highlight(null)}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.defaultPrevented) return
            if (event.key === 'Tab') event.preventDefault()
            else if (sub && event.key === 'ArrowLeft') {
              event.preventDefault()
              overlay.setOpen(false)
            } else if (menu.onKeyDown(event)) event.preventDefault()
          }}
        />
      </MenuContext.Provider>
    </Floating>
  )
})

export interface MenuItemProps extends HostProps {
  inset?: boolean
  disabled?: boolean
  textValue?: string
  onSelect?: (event: MenuSelectEvent) => void
}

/** One row. `rowClass` is the module's row style; `children` render after the indicator slot. */
export const MenuItemBase = forwardRef<
  PublicInstance,
  MenuItemProps & {
    rowClass: string
    role?: string
    /** Select items: lets the menu highlight the selected value on open. */
    value?: string
    indicator?: ReactNode
    after?: ReactNode
    openSub?: () => void
    /** Called when the highlight leaves this row, so a sub-menu closes as the pointer moves on. */
    closeSub?: () => void
    keepOpen?: boolean
  }
>(function MenuItemBase(
  {
    rowClass,
    className,
    inset,
    disabled = false,
    textValue,
    onSelect,
    role = 'menuitem',
    value,
    indicator,
    after,
    openSub,
    closeSub,
    keepOpen = false,
    children,
    onClick,
    onMouseMove,
    ...props
  },
  ref
) {
  const menu = useMenu('MenuItem')
  const closeRoot = useContext(RootCloseContext)
  const select = () => {
    if (openSub) {
      openSub()
      return
    }
    const event = selectEvent()
    onSelect?.(event)
    if (!event.defaultPrevented && !keepOpen) closeRoot()
  }
  const key = useMenuItem(menu, {
    disabled,
    textValue: textValue ?? textOf(children),
    value,
    select,
    openSub
  })
  const highlighted = menu.highlighted === key
  // Another row took the highlight: close this row's sub-menu. Leaving for the
  // sub-menu itself clears the highlight (null) and keeps it open.
  const movedOn = !highlighted && menu.highlighted !== null
  useLayoutEffect(() => {
    if (movedOn) closeSub?.()
  }, [movedOn, closeSub])
  return (
    <Box
      ref={ref}
      role={role}
      {...props}
      data-highlighted={highlighted ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cn(rowClass, inset && 'pl-8', className)}
      state={{ focus: highlighted, disabled }}
      onMouseMove={(event) => {
        onMouseMove?.(event)
        if (!disabled && menu.highlighted !== key) menu.highlight(key)
        if (openSub && !disabled) openSub()
      }}
      onClick={(event) => {
        onClick?.(event)
        if (!disabled) select()
      }}
    >
      {indicator}
      {children}
      {after}
    </Box>
  )
})

const CHECK = <Check className="h-3.5 w-3.5" />

export function Indicator({ show, className }: { show: boolean; className: string }) {
  return <Box className={className}>{show ? CHECK : null}</Box>
}

const RadioContext = createContext<{ value?: string; onValueChange?: (value: string) => void }>({})

export function MenuRadioGroup({
  value,
  onValueChange,
  children
}: {
  value?: string
  onValueChange?: (value: string) => void
  children?: ReactNode
}) {
  return (
    <RadioContext.Provider value={{ value, onValueChange }}>
      <Box role="group">{children}</Box>
    </RadioContext.Provider>
  )
}

export function useRadio() {
  return useContext(RadioContext)
}

export function MenuGroup({ children, ...props }: HostProps) {
  return (
    <Box role="group" {...props}>
      {children}
    </Box>
  )
}

/** A sub-menu: its own open state, anchored to its trigger row. */
export function MenuSub({ children, open, defaultOpen, onOpenChange }: MenuRootProps) {
  const overlay = useOverlayState({ open, defaultOpen, onOpenChange })
  return <OverlayContext.Provider value={overlay}>{children}</OverlayContext.Provider>
}

export const MenuSubTriggerBase = forwardRef<PublicInstance, MenuItemProps & { rowClass: string }>(
  function MenuSubTriggerBase({ rowClass, children, ...props }, ref) {
    const sub = useOverlay('MenuSubTrigger')
    const triggerRef = useTriggerRef(sub, ref)
    return (
      <MenuItemBase
        ref={triggerRef}
        rowClass={rowClass}
        aria-haspopup="menu"
        data-state={sub.open ? 'open' : 'closed'}
        {...props}
        openSub={() => {
          if (!sub.openRef.current) sub.setOpen(true, 'keyboard')
        }}
        closeSub={() => {
          if (sub.openRef.current) sub.setOpen(false)
        }}
        after={<ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />}
      >
        {children}
      </MenuItemBase>
    )
  }
)
