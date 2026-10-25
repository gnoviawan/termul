/**
 * Radix DropdownMenu on GPUIX anchored layers. The trigger opens on press
 * (pointer down, like Radix) and on Enter, Space or ArrowDown, which also
 * highlights the first item. See internal/menu.tsx for the keyboard model.
 */
import type { PublicInstance } from '@gpuix/react'
import { forwardRef, type ReactNode } from 'react'
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
  MenuSub,
  MenuSubTriggerBase,
  useRadio
} from './internal/menu-parts'
import { LAYER } from '../compat/stacking'
import { useOverlay } from './internal/overlay'
import { TriggerBase, type TriggerProps } from './internal/trigger'
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

const DropdownMenu = MenuRoot

const DropdownMenuTrigger = forwardRef<PublicInstance, TriggerProps>(function DropdownMenuTrigger(
  { onMouseDown, onKeyDown, disabled, ...props },
  ref
) {
  const overlay = useOverlay('menu', 'DropdownMenuTrigger')
  return (
    <TriggerBase
      ref={ref}
      overlay={overlay}
      aria-haspopup="menu"
      disabled={disabled}
      {...props}
      onMouseDown={(event) => {
        onMouseDown?.(event)
        if (disabled || event.defaultPrevented || event.button !== 0 || event.ctrlKey) return
        overlay.setOpen(!overlay.openRef.current, 'pointer')
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (disabled || event.defaultPrevented) return
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault()
          overlay.setOpen(true, 'keyboard')
        }
      }}
    />
  )
})

const DropdownMenuGroup = MenuGroup

/** GPUIX portals the content itself; this exists so call sites that name it still compile. */
const DropdownMenuPortal = ({ children }: { children?: ReactNode }) => <>{children}</>

const DropdownMenuSub = MenuSub

const DropdownMenuRadioGroup = MenuRadioGroup

const DropdownMenuSubTrigger = forwardRef<PublicInstance, MenuItemProps & { inset?: boolean }>(
  ({ className, ...props }, ref) => (
    <MenuSubTriggerBase
      ref={ref}
      rowClass={cn(MENU_ITEM_CLASS, MENU_SUB_TRIGGER_OPEN_CLASS)}
      className={className}
      {...props}
    />
  )
)
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger'

const DropdownMenuSubContent = forwardRef<PublicInstance, MenuContentProps>(
  ({ className, ...props }, ref) => (
    <MenuContentBase
      ref={ref}
      side="right"
      align="start"
      sub
      priority={LAYER.submenu}
      {...props}
      className={cn(MENU_CONTENT_CLASS, 'shadow-lg', MENU_MOTION_CLASS, className)}
    />
  )
)
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent'

const DropdownMenuContent = forwardRef<PublicInstance, MenuContentProps>(
  ({ className, sideOffset = 4, ...props }, ref) => (
    <MenuContentBase
      ref={ref}
      sideOffset={sideOffset}
      {...props}
      className={cn(MENU_CONTENT_CLASS, MENU_MOTION_CLASS, className)}
    />
  )
)
DropdownMenuContent.displayName = 'DropdownMenuContent'

const DropdownMenuItem = forwardRef<PublicInstance, MenuItemProps>((props, ref) => (
  <MenuItemBase ref={ref} rowClass={MENU_ITEM_CLASS} {...props} />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export interface CheckboxItemProps extends MenuItemProps {
  checked?: boolean | 'indeterminate'
  onCheckedChange?: (checked: boolean) => void
}

const DropdownMenuCheckboxItem = forwardRef<PublicInstance, CheckboxItemProps>(
  ({ className, checked = false, onCheckedChange, onSelect, ...props }, ref) => (
    <MenuItemBase
      ref={ref}
      role="menuitemcheckbox"
      rowClass={cn(MENU_ITEM_CLASS, 'pl-8')}
      className={className}
      data-state={checked === true ? 'checked' : 'unchecked'}
      indicator={<Indicator show={checked === true} className={MENU_INDICATOR_CLASS} />}
      onSelect={(event) => {
        onSelect?.(event)
        onCheckedChange?.(checked !== true)
      }}
      {...props}
    />
  )
)
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem'

const DropdownMenuRadioItem = forwardRef<PublicInstance, MenuItemProps & { value: string }>(
  ({ className, value, onSelect, ...props }, ref) => {
    const radio = useRadio()
    const checked = radio.value === value
    return (
      <MenuItemBase
        ref={ref}
        role="menuitemradio"
        rowClass={cn(MENU_ITEM_CLASS, 'pl-8')}
        className={className}
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
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem'

const DropdownMenuLabel = forwardRef<PublicInstance, HostProps & { inset?: boolean }>(
  ({ className, inset, ...props }, ref) => (
    <Box ref={ref} {...props} className={cn(MENU_LABEL_CLASS, inset && 'pl-8', className)} />
  )
)
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

const DropdownMenuSeparator = forwardRef<PublicInstance, HostProps>(
  ({ className, ...props }, ref) => (
    <Box ref={ref} role="separator" {...props} className={cn(MENU_SEPARATOR_CLASS, className)} />
  )
)
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

const DropdownMenuShortcut = ({ className, ...props }: HostProps) => (
  <Box {...props} className={cn(MENU_SHORTCUT_CLASS, className)} />
)
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut'

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
}
