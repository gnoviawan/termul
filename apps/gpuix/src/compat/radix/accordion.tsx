/**
 * `@radix-ui/react-accordion` stand-in: a root `div` that keeps the open
 * items (`type` single or multiple, controlled or not), items that know
 * whether they are open, a trigger button that toggles its item, and content
 * that mounts only while its item is open. Every part keeps its DOM props, so
 * the shadcn wrapper's classes apply as on the web.
 */
import { createContext, forwardRef, type ReactNode, useContext, useState } from 'react'
import { Slot } from './core'

// biome-ignore lint/suspicious/noExplicitAny: a Radix stand-in passes arbitrary DOM props through
type AnyProps = { children?: ReactNode; [prop: string]: any }

interface RootState {
  open: readonly string[]
  toggle(value: string): void
  disabled: boolean
}

interface ItemState {
  value: string
  open: boolean
  disabled: boolean
}

const RootCtx = createContext<RootState | null>(null)
const ItemCtx = createContext<ItemState | null>(null)

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : []

export const Root = forwardRef<HTMLDivElement, AnyProps>(function Root(
  {
    type,
    value,
    defaultValue,
    onValueChange,
    collapsible = false,
    disabled = false,
    orientation,
    dir: _dir,
    children,
    ...props
  },
  ref
) {
  const multiple = type === 'multiple'
  const [inner, setInner] = useState<string[]>(() => asList(defaultValue))
  const open = value !== undefined ? asList(value) : inner
  const toggle = (item: string) => {
    const isOpen = open.includes(item)
    if (!multiple && isOpen && !collapsible) return
    const next = multiple
      ? isOpen
        ? open.filter((v) => v !== item)
        : [...open, item]
      : isOpen
        ? []
        : [item]
    if (value === undefined) setInner(next)
    onValueChange?.(multiple ? next : (next[0] ?? ''))
  }
  return (
    <RootCtx.Provider value={{ open, toggle, disabled }}>
      <div ref={ref} data-orientation={orientation ?? 'vertical'} {...props}>
        {children}
      </div>
    </RootCtx.Provider>
  )
})

function useRoot(part: string): RootState {
  const root = useContext(RootCtx)
  if (!root) throw new Error(`compat radix: <Accordion.${part}> outside its Root`)
  return root
}

function useItem(part: string): ItemState {
  const item = useContext(ItemCtx)
  if (!item) throw new Error(`compat radix: <Accordion.${part}> outside its Item`)
  return item
}

const stateOf = (open: boolean) => (open ? 'open' : 'closed')

export const Item = forwardRef<HTMLDivElement, AnyProps>(function Item(
  { value, disabled, children, ...props },
  ref
) {
  const root = useRoot('Item')
  const item = { value, open: root.open.includes(value), disabled: !!disabled || root.disabled }
  return (
    <ItemCtx.Provider value={item}>
      <div
        ref={ref}
        data-state={stateOf(item.open)}
        data-disabled={item.disabled ? '' : undefined}
        {...props}
      >
        {children}
      </div>
    </ItemCtx.Provider>
  )
})

export const Header = forwardRef<HTMLHeadingElement, AnyProps>(function Header(
  { asChild, children, ...props },
  ref
) {
  const item = useItem('Header')
  const merged = { ...props, 'data-state': stateOf(item.open), ref }
  if (asChild) return <Slot {...merged}>{children}</Slot>
  return <h3 {...merged}>{children}</h3>
})

export const Trigger = forwardRef<HTMLButtonElement, AnyProps>(function Trigger(
  { asChild, onClick, children, ...props },
  ref
) {
  const root = useRoot('Trigger')
  const item = useItem('Trigger')
  const merged: AnyProps = {
    type: 'button',
    'aria-expanded': item.open,
    'data-state': stateOf(item.open),
    'data-disabled': item.disabled ? '' : undefined,
    disabled: item.disabled,
    ...props,
    onClick: (event: unknown) => {
      onClick?.(event)
      if (!item.disabled) root.toggle(item.value)
    },
    ref
  }
  if (asChild) return <Slot {...merged}>{children}</Slot>
  return <button {...merged}>{children}</button>
})

export const Content = forwardRef<HTMLDivElement, AnyProps>(function Content(
  { forceMount, children, ...props },
  ref
) {
  const item = useItem('Content')
  if (!item.open && !forceMount) return null
  return (
    <div ref={ref} role="region" data-state={stateOf(item.open)} hidden={!item.open} {...props}>
      {children}
    </div>
  )
})
