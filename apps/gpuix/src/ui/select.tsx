/**
 * Radix Select (popper position) on GPUIX anchored layers. Opening highlights
 * the selected item; arrows, Home/End, typeahead and Enter work as in a menu;
 * choosing an item sets the value, closes and returns focus to the trigger.
 *
 * Radix renders closed content into a detached fragment so `SelectValue` can
 * show the selected item's text. Here closed content renders in "collect"
 * mode: items register their label and paint nothing.
 */
import { type PublicInstance, useGpuix } from '@gpuix/react'
import {
  createContext,
  forwardRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronUp } from '../icons'
import { Box, type HostProps, mergeRefs, wrapText } from './internal/host'
import { MenuContext, useMenuModel } from './internal/menu'
import { Indicator, MenuItemBase, type MenuItemProps } from './internal/menu-parts'
import {
  Floating,
  OverlayContext,
  type OverlayState,
  useControllableState,
  useLayer,
  useOverlay,
  useOverlayState
} from './internal/overlay'
import { TriggerBase, type TriggerProps } from './internal/trigger'
import {
  MENU_CONTENT_CLASS,
  MENU_INDICATOR_CLASS,
  MENU_ITEM_CLASS,
  MENU_LABEL_CLASS,
  MENU_MOTION_CLASS,
  MENU_SEPARATOR_CLASS
} from './menu-styles'
import { FIELD_FOCUS_CLASS } from './panel-styles'

interface SelectState {
  value: string | undefined
  setValue(value: string): void
  disabled: boolean
  labelOf(value: string | undefined): ReactNode | undefined
  setLabel(value: string, label: ReactNode): void
}

const SelectContext = createContext<SelectState | null>(null)
const CollectContext = createContext(false)

function useSelect(part: string): SelectState {
  const select = useContext(SelectContext)
  if (!select) throw new Error(`${part} must be inside Select`)
  return select
}

export interface SelectProps {
  children?: ReactNode
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  name?: string
  required?: boolean
  dir?: 'ltr' | 'rtl'
}

function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  open,
  defaultOpen,
  onOpenChange,
  disabled = false
}: SelectProps) {
  const overlay = useOverlayState({ open, defaultOpen, onOpenChange })
  const [current, setCurrent] = useControllableState<string | undefined>(
    value,
    defaultValue,
    (next) => {
      if (next !== undefined) onValueChange?.(next)
    }
  )
  const labels = useRef(new Map<string, ReactNode>())
  const [, setVersion] = useState(0)
  const setLabel = useCallback((key: string, label: ReactNode) => {
    if (labels.current.get(key) === label) return
    labels.current.set(key, label)
    setVersion((v) => v + 1)
  }, [])
  const state = useMemo<SelectState>(
    () => ({
      value: current,
      setValue: setCurrent,
      disabled,
      labelOf: (key) => (key === undefined ? undefined : labels.current.get(key)),
      setLabel
    }),
    [current, setCurrent, disabled, setLabel]
  )
  return (
    <OverlayContext.select.Provider value={overlay}>
      <SelectContext.Provider value={state}>{children}</SelectContext.Provider>
    </OverlayContext.select.Provider>
  )
}

function SelectGroup({ children, ...props }: HostProps) {
  if (useContext(CollectContext)) return <>{children}</>
  return (
    <Box role="group" {...props}>
      {children}
    </Box>
  )
}

function SelectValue({ placeholder }: { placeholder?: ReactNode; className?: string }) {
  const select = useSelect('SelectValue')
  const label = select.labelOf(select.value)
  return <>{wrapText(label ?? placeholder)}</>
}

const TRIGGER_CLASS =
  'flex h-10 w-full items-center justify-between rounded-lg border border-field-border bg-background px-3 py-2 text-sm transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1'

const SelectTrigger = forwardRef<PublicInstance, TriggerProps>(function SelectTrigger(
  { className, children, onMouseDown, onKeyDown, ...props },
  ref
) {
  const overlay = useOverlay('select', 'SelectTrigger')
  const select = useSelect('SelectTrigger')
  const disabled = select.disabled || props.disabled === true
  return (
    <TriggerBase
      ref={ref}
      overlay={overlay}
      role="combobox"
      aria-haspopup="listbox"
      {...props}
      disabled={disabled}
      className={cn(TRIGGER_CLASS, FIELD_FOCUS_CLASS, className)}
      onMouseDown={(event) => {
        onMouseDown?.(event)
        if (disabled || event.defaultPrevented || event.button !== 0) return
        overlay.setOpen(!overlay.openRef.current, 'pointer')
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (disabled || event.defaultPrevented) return
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault()
          overlay.setOpen(true, 'keyboard')
        }
      }}
    >
      {children}
      <ChevronDown className="h-4 w-4 opacity-50" />
    </TriggerBase>
  )
})

const SelectScrollUpButton = ({ className }: { className?: string }) => (
  <Box className={cn('flex cursor-default items-center justify-center py-1', className)}>
    <ChevronUp className="h-4 w-4" />
  </Box>
)

const SelectScrollDownButton = ({ className }: { className?: string }) => (
  <Box className={cn('flex cursor-default items-center justify-center py-1', className)}>
    <ChevronDown className="h-4 w-4" />
  </Box>
)

export interface SelectContentProps extends HostProps {
  position?: 'popper' | 'item-aligned'
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  onEscapeKeyDown?: (event: { preventDefault(): void }) => void
  onPointerDownOutside?: (event: { preventDefault(): void }) => void
  onCloseAutoFocus?: (event: { preventDefault(): void }) => void
}

/** `data-[side=bottom]:translate-y-1` and friends: the popper's 4px nudge, as extra offset. */
const POPPER_NUDGE = 4

const SelectContent = forwardRef<PublicInstance, SelectContentProps>(function SelectContent(
  { children, ...props },
  ref
) {
  const overlay = useOverlay('select', 'SelectContent')
  if (!overlay.open) return <CollectContext.Provider value>{children}</CollectContext.Provider>
  return (
    <OpenSelect ref={ref} overlay={overlay} {...props}>
      {children}
    </OpenSelect>
  )
})

const OpenSelect = forwardRef<PublicInstance, SelectContentProps & { overlay: OverlayState }>(
  function OpenSelect(
    {
      overlay,
      className,
      children,
      position = 'popper',
      side = 'bottom',
      align = 'start',
      sideOffset = 0,
      onEscapeKeyDown: _onEscapeKeyDown,
      onPointerDownOutside: _onPointerDownOutside,
      onCloseAutoFocus: _onCloseAutoFocus,
      ...props
    },
    ref
  ) {
    const select = useSelect('SelectContent')
    const menu = useMenuModel()
    const { renderer } = useGpuix()
    const content = useRef<PublicInstance | null>(null)
    const { node, onMouseDownOutside } = useLayer(overlay, content, () => overlay.setOpen(false))
    const triggerWidth = overlay.trigger
      ? renderer?.getElementBounds?.(overlay.trigger.id)?.width
      : undefined
    // Items mount once the trigger is known (the content portals into it), so wait for it.
    const mounted = overlay.trigger !== null
    useLayoutEffect(() => {
      if (mounted) menu.highlightValue(select.value)
    }, [menu.highlightValue, select.value, mounted])
    return (
      <Floating
        overlay={overlay}
        layer={node}
        side={side}
        align={align}
        sideOffset={sideOffset + (position === 'popper' ? POPPER_NUDGE : 0)}
        onDismiss={() => overlay.setOpen(false)}
        focusContent={() => content.current?.id ?? null}
      >
        <MenuContext.Provider value={menu}>
          <Box
            ref={mergeRefs(ref, content)}
            role="listbox"
            tabIndex={-1}
            data-state="open"
            data-side={side}
            {...props}
            className={cn(
              MENU_CONTENT_CLASS,
              'relative max-h-96 p-0',
              MENU_MOTION_CLASS,
              className
            )}
            native={{ onMouseDownOutside }}
            onMouseLeave={() => menu.highlight(null)}
            onKeyDown={(event) => {
              if (event.key === 'Tab') event.preventDefault()
              else if (menu.onKeyDown(event)) event.preventDefault()
            }}
          >
            <Box className="p-1" style={triggerWidth ? { minWidth: triggerWidth } : undefined}>
              {children}
            </Box>
          </Box>
        </MenuContext.Provider>
      </Floating>
    )
  }
)

const SelectLabel = forwardRef<PublicInstance, HostProps>(({ className, ...props }, ref) => {
  if (useContext(CollectContext)) return null
  return <Box ref={ref} {...props} className={cn(MENU_LABEL_CLASS, 'pl-8', className)} />
})
SelectLabel.displayName = 'SelectLabel'

export interface SelectItemProps extends Omit<MenuItemProps, 'onSelect'> {
  value: string
}

/** Whether the item being rendered is the selected one, for `SelectItemIndicator`. */
const ItemSelectedContext = createContext(false)

/**
 * Radix `Select.ItemText`: the part of an item the trigger shows. An item
 * without one shows all of its children, as `SelectItem` always has.
 */
function SelectItemText({ children }: { children?: ReactNode }) {
  return <>{wrapText(children)}</>
}

/** Radix `Select.ItemIndicator`: its children paint on the selected item only. */
function SelectItemIndicator({ children }: { children?: ReactNode }) {
  return useContext(ItemSelectedContext) ? <>{children}</> : null
}

/** The first element of type `part` in an item's children, searched depth first. */
function findPart(children: ReactNode, part: unknown): ReactElement<{ children?: ReactNode }> | null {
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    if (Array.isArray(child)) {
      const hit = findPart(child, part)
      if (hit) return hit
      continue
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) continue
    if (child.type === part) return child
    const hit = findPart(child.props.children, part)
    if (hit) return hit
  }
  return null
}

function CollectItem({ value, children }: { value: string; children?: ReactNode }) {
  const select = useSelect('SelectItem')
  const label = findPart(children, SelectItemText)?.props.children ?? children
  useLayoutEffect(() => select.setLabel(value, label), [select.setLabel, value, label])
  return null
}

function OpenItem({
  value,
  className,
  children,
  itemRef,
  ...rest
}: SelectItemProps & { itemRef: Ref<PublicInstance> }) {
  const select = useSelect('SelectItem')
  const overlay = useOverlay('select', 'SelectItem')
  const selected = select.value === value
  const label = findPart(children, SelectItemText)?.props.children ?? children
  const ownIndicator = findPart(children, SelectItemIndicator) !== null
  useLayoutEffect(() => select.setLabel(value, label), [select.setLabel, value, label])
  return (
    <ItemSelectedContext.Provider value={selected}>
    <MenuItemBase
      ref={itemRef}
      role="option"
      aria-selected={selected}
      data-state={selected ? 'checked' : 'unchecked'}
      rowClass={cn(MENU_ITEM_CLASS, 'w-full pl-8')}
      className={className}
      value={value}
      keepOpen
      indicator={ownIndicator ? undefined : <Indicator show={selected} className={MENU_INDICATOR_CLASS} />}
      onSelect={() => {
        select.setValue(value)
        overlay.setOpen(false)
      }}
      {...rest}
    >
      {children}
    </MenuItemBase>
    </ItemSelectedContext.Provider>
  )
}

const SelectItem = forwardRef<PublicInstance, SelectItemProps>(function SelectItem(props, ref) {
  if (useContext(CollectContext))
    return <CollectItem value={props.value}>{props.children}</CollectItem>
  return <OpenItem {...props} itemRef={ref} />
})

const SelectSeparator = forwardRef<PublicInstance, HostProps>(({ className, ...props }, ref) => {
  if (useContext(CollectContext)) return null
  return (
    <Box ref={ref} role="separator" {...props} className={cn(MENU_SEPARATOR_CLASS, className)} />
  )
})
SelectSeparator.displayName = 'SelectSeparator'

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue
}
