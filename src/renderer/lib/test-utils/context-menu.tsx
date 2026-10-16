import * as React from 'react'

interface OpenState {
  open: boolean
  setOpen: (open: boolean) => void
}

const MenuContext = React.createContext<OpenState>({ open: false, setOpen: () => {} })
const SubContext = React.createContext<OpenState>({ open: false, setOpen: () => {} })
const RadioContext = React.createContext<{
  value?: string
  onValueChange?: (value: string) => void
}>({})

interface ChildrenProps {
  children?: React.ReactNode
}

interface PassthroughProps extends ChildrenProps {
  className?: string
  style?: React.CSSProperties
  'data-testid'?: string
}

function passthrough({ className, style, 'data-testid': testId }: PassthroughProps) {
  return { className, style, 'data-testid': testId }
}

export function ContextMenu({
  children,
  onOpenChange
}: ChildrenProps & { onOpenChange?: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpenState] = React.useState(false)
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])
  return <MenuContext.Provider value={{ open, setOpen }}>{children}</MenuContext.Provider>
}

export function ContextMenuTrigger({
  children,
  asChild,
  disabled
}: ChildrenProps & { asChild?: boolean; disabled?: boolean }): React.JSX.Element {
  const { setOpen } = React.useContext(MenuContext)
  const openUnlessPrevented = (e: React.MouseEvent): void => {
    if (disabled || e.defaultPrevented) return
    e.preventDefault()
    setOpen(true)
  }
  if (asChild && React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      onContextMenu?: (e: React.MouseEvent) => void
    }>
    return React.cloneElement(child, {
      onContextMenu: (e: React.MouseEvent) => {
        child.props.onContextMenu?.(e)
        openUnlessPrevented(e)
      }
    })
  }
  return <div onContextMenu={openUnlessPrevented}>{children}</div>
}

export function ContextMenuContent(props: PassthroughProps): React.JSX.Element | null {
  const { open } = React.useContext(MenuContext)
  if (!open) return null
  return (
    <div role="menu" {...passthrough(props)}>
      {props.children}
    </div>
  )
}

function useSelect(onSelect?: (event: Event) => void): () => void {
  const { setOpen } = React.useContext(MenuContext)
  return () => {
    const event = new Event('select', { cancelable: true })
    onSelect?.(event)
    if (!event.defaultPrevented) setOpen(false)
  }
}

interface ItemProps extends PassthroughProps {
  disabled?: boolean
  onSelect?: (event: Event) => void
}

export function ContextMenuItem({
  disabled,
  onSelect,
  variant,
  ...props
}: ItemProps & { variant?: 'default' | 'destructive' }): React.JSX.Element {
  const select = useSelect(onSelect)
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? '' : undefined}
      data-variant={variant}
      onClick={() => {
        if (!disabled) select()
      }}
      {...passthrough(props)}
    >
      {props.children}
    </div>
  )
}

export function ContextMenuCheckboxItem({
  checked,
  disabled,
  onCheckedChange,
  onSelect,
  ...props
}: ItemProps & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}): React.JSX.Element {
  const select = useSelect(onSelect)
  return (
    <div
      role="menuitemcheckbox"
      tabIndex={-1}
      aria-checked={checked ?? false}
      aria-disabled={disabled || undefined}
      data-checked={checked ? '' : undefined}
      onClick={() => {
        if (disabled) return
        onCheckedChange?.(!checked)
        select()
      }}
      {...passthrough(props)}
    >
      {props.children}
    </div>
  )
}

export function ContextMenuRadioGroup({
  children,
  value,
  onValueChange
}: ChildrenProps & { value?: string; onValueChange?: (value: string) => void }): React.JSX.Element {
  return <RadioContext.Provider value={{ value, onValueChange }}>{children}</RadioContext.Provider>
}

export function ContextMenuRadioItem({
  value,
  disabled,
  onSelect,
  ...props
}: ItemProps & { value: string }): React.JSX.Element {
  const radio = React.useContext(RadioContext)
  const select = useSelect(onSelect)
  return (
    <div
      role="menuitemradio"
      tabIndex={-1}
      aria-checked={radio.value === value}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        radio.onValueChange?.(value)
        select()
      }}
      {...passthrough(props)}
    >
      {props.children}
    </div>
  )
}

export function ContextMenuSub({ children }: ChildrenProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  return <SubContext.Provider value={{ open, setOpen }}>{children}</SubContext.Provider>
}

export function ContextMenuSubTrigger({
  disabled,
  ...props
}: PassthroughProps & { disabled?: boolean }): React.JSX.Element {
  const { setOpen } = React.useContext(SubContext)
  const openUnlessDisabled = (): void => {
    if (!disabled) setOpen(true)
  }
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-haspopup="menu"
      aria-disabled={disabled || undefined}
      data-disabled={disabled ? '' : undefined}
      onMouseEnter={openUnlessDisabled}
      onClick={openUnlessDisabled}
      {...passthrough(props)}
    >
      {props.children}
    </div>
  )
}

export function ContextMenuSubContent(props: PassthroughProps): React.JSX.Element | null {
  const { open } = React.useContext(SubContext)
  if (!open) return null
  return (
    <div role="menu" {...passthrough(props)}>
      {props.children}
    </div>
  )
}

export function ContextMenuSeparator(): React.JSX.Element {
  return <hr />
}

export function ContextMenuLabel(props: PassthroughProps): React.JSX.Element {
  return <div {...passthrough(props)}>{props.children}</div>
}

export function ContextMenuGroup(props: PassthroughProps): React.JSX.Element {
  return <div {...passthrough(props)}>{props.children}</div>
}

export function ContextMenuShortcut(props: PassthroughProps): React.JSX.Element {
  return <span {...passthrough(props)}>{props.children}</span>
}

export function ContextMenuPortal({ children }: ChildrenProps): React.JSX.Element {
  return <>{children}</>
}
