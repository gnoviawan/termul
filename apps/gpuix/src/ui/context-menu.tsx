/**
 * Radix ContextMenu on GPUIX anchored layers: a right press on the trigger
 * area opens the menu at the pointer, flipped to stay in the window. Items,
 * keyboard model and dismissal are the DropdownMenu ones (internal/menu-parts).
 */
import type { PublicInstance } from '@gpuix/react'
import { createContext, forwardRef, type ReactNode, useContext, useState } from 'react'
import { cn } from '@/lib/utils'
import { Box, type HostProps } from './internal/host'
import {
  Indicator,
  MenuContentBase,
  type MenuContentProps,
  MenuGroup,
  MenuItemBase,
  type MenuItemProps,
  MenuRadioGroup,
  MenuRoot,
  type MenuRootProps,
  MenuSub,
  MenuSubTriggerBase,
  useRadio
} from './internal/menu-parts'
import { useOverlay } from './internal/overlay'
import { Slot } from './internal/slot'
import { useTriggerRef } from './internal/trigger'
import {
  MENU_CONTENT_CLASS,
  MENU_INDICATOR_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_MOTION_CLASS,
  MENU_SEPARATOR_CLASS,
  MENU_SHORTCUT_CLASS,
  MENU_SUB_TRIGGER_OPEN_CLASS
} from './menu-styles'

const MENU_TOUCH_ROW_CLASS = 'pointer-coarse:min-h-11'
const MENU_REDUCED_MOTION_CLASS = 'motion-reduce:animate-none!'
const ROW_CLASS = cn(MENU_ITEM_CLASS, MENU_TOUCH_ROW_CLASS)

type Point = { x: number; y: number }
const PointContext = createContext<{ point: Point; setPoint(point: Point): void }>({
  point: { x: 0, y: 0 },
  setPoint: () => {}
})

function ContextMenu({
  onOpenChange,
  children,
  ...props
}: Omit<MenuRootProps, 'open' | 'defaultOpen'>) {
  const [point, setPoint] = useState<Point>({ x: 0, y: 0 })
  return (
    <PointContext.Provider value={{ point, setPoint }}>
      <MenuRoot onOpenChange={onOpenChange} {...props}>
        {children}
      </MenuRoot>
    </PointContext.Provider>
  )
}

const ContextMenuTrigger = forwardRef<
  PublicInstance,
  HostProps & { asChild?: boolean; disabled?: boolean }
>(function ContextMenuTrigger({ asChild, disabled = false, onAuxClick, ...props }, ref) {
  const overlay = useOverlay('menu', 'ContextMenuTrigger')
  const { setPoint } = useContext(PointContext)
  const triggerRef = useTriggerRef(overlay, ref)
  const open: HostProps['onAuxClick'] = (event) => {
    onAuxClick?.(event)
    if (disabled || event.button !== 2 || event.defaultPrevented) return
    setPoint({ x: event.clientX, y: event.clientY })
    overlay.setOpen(true, 'pointer')
  }
  const state = overlay.open ? 'open' : 'closed'
  if (asChild) return <Slot ref={triggerRef} {...props} onAuxClick={open} data-state={state} />
  return <Box ref={triggerRef} {...props} onAuxClick={open} data-state={state} />
})

const ContextMenuGroup = MenuGroup
const ContextMenuPortal = ({ children }: { children?: ReactNode }) => <>{children}</>
const ContextMenuSub = MenuSub
const ContextMenuRadioGroup = MenuRadioGroup

const ContextMenuSubTrigger = forwardRef<PublicInstance, MenuItemProps>((props, ref) => (
  <MenuSubTriggerBase ref={ref} rowClass={cn(ROW_CLASS, MENU_SUB_TRIGGER_OPEN_CLASS)} {...props} />
))
ContextMenuSubTrigger.displayName = 'ContextMenuSubTrigger'

const ContextMenuSubContent = forwardRef<PublicInstance, MenuContentProps>(
  ({ className, ...props }, ref) => (
    <MenuContentBase
      ref={ref}
      side="right"
      align="start"
      sub
      priority={3}
      {...props}
      className={cn(MENU_CONTENT_CLASS, MENU_MOTION_CLASS, MENU_REDUCED_MOTION_CLASS, className)}
    />
  )
)
ContextMenuSubContent.displayName = 'ContextMenuSubContent'

const ContextMenuContent = forwardRef<PublicInstance, MenuContentProps>(
  ({ className, ...props }, ref) => {
    const { point } = useContext(PointContext)
    return (
      <MenuContentBase
        ref={ref}
        position={point}
        side="bottom"
        align="start"
        {...props}
        className={cn(MENU_CONTENT_CLASS, MENU_MOTION_CLASS, MENU_REDUCED_MOTION_CLASS, className)}
      />
    )
  }
)
ContextMenuContent.displayName = 'ContextMenuContent'

const ContextMenuItem = forwardRef<PublicInstance, MenuItemProps>((props, ref) => (
  <MenuItemBase ref={ref} rowClass={ROW_CLASS} {...props} />
))
ContextMenuItem.displayName = 'ContextMenuItem'

const ContextMenuCheckboxItem = forwardRef<
  PublicInstance,
  MenuItemProps & {
    checked?: boolean | 'indeterminate'
    onCheckedChange?: (checked: boolean) => void
  }
>(({ checked = false, onCheckedChange, onSelect, ...props }, ref) => (
  <MenuItemBase
    ref={ref}
    role="menuitemcheckbox"
    rowClass={cn(ROW_CLASS, 'pl-8')}
    data-state={checked === true ? 'checked' : 'unchecked'}
    indicator={<Indicator show={checked === true} className={MENU_INDICATOR_CLASS} />}
    onSelect={(event) => {
      onSelect?.(event)
      onCheckedChange?.(checked !== true)
    }}
    {...props}
  />
))
ContextMenuCheckboxItem.displayName = 'ContextMenuCheckboxItem'

const ContextMenuRadioItem = forwardRef<PublicInstance, MenuItemProps & { value: string }>(
  ({ value, onSelect, ...props }, ref) => {
    const radio = useRadio()
    const checked = radio.value === value
    return (
      <MenuItemBase
        ref={ref}
        role="menuitemradio"
        rowClass={cn(ROW_CLASS, 'pl-8')}
        data-state={checked ? 'checked' : 'unchecked'}
        indicator={<Indicator show={checked} className={MENU_INDICATOR_CLASS} />}
        onSelect={(event) => {
          onSelect?.(event)
          radio.onValueChange?.(value)
        }}
        {...props}
      />
    )
  }
)
ContextMenuRadioItem.displayName = 'ContextMenuRadioItem'

const ContextMenuLabel = forwardRef<PublicInstance, HostProps & { inset?: boolean }>(
  ({ className, inset, ...props }, ref) => (
    <Box ref={ref} {...props} className={cn(MENU_LABEL_CLASS, inset && 'pl-8', className)} />
  )
)
ContextMenuLabel.displayName = 'ContextMenuLabel'

const ContextMenuSeparator = forwardRef<PublicInstance, HostProps>(
  ({ className, ...props }, ref) => (
    <Box ref={ref} role="separator" {...props} className={cn(MENU_SEPARATOR_CLASS, className)} />
  )
)
ContextMenuSeparator.displayName = 'ContextMenuSeparator'

const ContextMenuShortcut = ({ className, ...props }: HostProps) => (
  <Box {...props} className={cn(MENU_SHORTCUT_CLASS, className)} />
)
ContextMenuShortcut.displayName = 'ContextMenuShortcut'

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
}
