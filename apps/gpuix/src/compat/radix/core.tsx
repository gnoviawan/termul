/**
 * Radix-shaped primitives (from the X1 prototype). The shadcn wrappers in
 * `src/renderer/components/ui` run unchanged on top of these: they only see
 * the Radix part names. Open content mounts as a GPUIX `<anchored>` portalled
 * into the trigger element, so it paints above the tree.
 */

import { createPortal } from '@gpuix/react'
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { type CompatElement, trackedInstance } from '../dom-node'
import { domPropsOf } from '../create'
import { compatWarn } from '../log'

// biome-ignore lint/suspicious/noExplicitAny: a Radix stand-in passes arbitrary DOM props through
type AnyProps = { children?: ReactNode; [prop: string]: any }

function composeRefs(...refs: unknown[]) {
  return (value: unknown) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value)
      else if (ref && typeof ref === 'object') (ref as { current: unknown }).current = value
    }
  }
}

function mergeProps(slot: AnyProps, child: AnyProps): AnyProps {
  const out: AnyProps = { ...slot, ...child }
  for (const key of Object.keys(slot)) {
    const a = slot[key]
    const b = child[key]
    if (key.startsWith('on') && typeof a === 'function' && typeof b === 'function') {
      out[key] = (...args: unknown[]) => {
        ;(b as (...x: unknown[]) => void)(...args)
        ;(a as (...x: unknown[]) => void)(...args)
      }
    } else if (key === 'className' && a && b) out[key] = `${a} ${b}`
    else if (key === 'style' && a && b) out[key] = { ...(a as object), ...(b as object) }
  }
  return out
}

export const Slot = forwardRef<HTMLDivElement, AnyProps>(function Slot({ children, ...props }, ref) {
  const only = Children.toArray(children).find(isValidElement)
  if (!only) return null
  const childProps = (domPropsOf(only) ?? only.props) as AnyProps
  const childRef = (childProps as { ref?: unknown }).ref
  return cloneElement(only, { ...mergeProps(props, childProps), ref: composeRefs(ref, childRef) } as never)
})
export const Root = Slot
export const Slottable = ({ children }: AnyProps) => <>{children}</>

interface OverlayState {
  open: boolean
  setOpen(next: boolean): void
  anchor: CompatElement | null
  setAnchor(el: CompatElement | null): void
  kind: 'tooltip' | 'popover' | 'menu' | 'context' | 'dialog'
}

const OverlayCtx = createContext<OverlayState | null>(null)

function useOverlay(part: string): OverlayState {
  const ctx = useContext(OverlayCtx)
  if (!ctx) throw new Error(`compat radix: <${part}> outside its Root`)
  return ctx
}

export function makeRoot(kind: OverlayState['kind']) {
  return function OverlayRoot(props: AnyProps) {
    const controlled = props.open !== undefined
    const [inner, setInner] = useState(!!props.defaultOpen)
    const open = controlled ? !!props.open : inner
    const onOpenChange = props.onOpenChange as ((v: boolean) => void) | undefined
    const [anchor, setAnchor] = useState<CompatElement | null>(null)
    const setOpen = useCallback(
      (next: boolean) => {
        if (!controlled) setInner(next)
        onOpenChange?.(next)
      },
      [controlled, onOpenChange]
    )
    const value = useMemo(() => ({ open, setOpen, anchor, setAnchor, kind }), [open, setOpen, anchor])
    return <OverlayCtx.Provider value={value}>{props.children}</OverlayCtx.Provider>
  }
}

export function makeTrigger(part: string) {
  return forwardRef<HTMLDivElement, AnyProps>(function Trigger({ asChild, children, ...props }, ref) {
    const ctx = useOverlay(part)
    const handlers: AnyProps = { 'data-state': ctx.open ? 'open' : 'closed' }
    if (ctx.kind === 'tooltip') {
      handlers.onMouseEnter = () => ctx.setOpen(true)
      handlers.onMouseLeave = () => ctx.setOpen(false)
      handlers['data-state'] = ctx.open ? 'delayed-open' : 'closed'
    } else if (ctx.kind === 'context') {
      handlers.onContextMenu = (e: { preventDefault(): void }) => {
        e.preventDefault()
        ctx.setOpen(true)
      }
    } else {
      handlers.onClick = () => ctx.setOpen(!ctx.open)
    }
    const setAnchor = ctx.setAnchor
    const anchorRef = useCallback((el: unknown) => setAnchor((el as CompatElement) ?? null), [setAnchor])
    const merged = { ...props, ...handlers, ref: composeRefs(ref, anchorRef) }
    if (ctx.kind === 'context') {
      // Radix ContextMenu.Trigger renders a span around arbitrary content.
      return asChild ? <Slot {...merged}>{children}</Slot> : <span {...merged}>{children}</span>
    }
    if (asChild) return <Slot {...merged}>{children}</Slot>
    return (
      <button type="button" {...merged}>
        {children}
      </button>
    )
  })
}

export function Portal({ children }: AnyProps) {
  return <>{children}</>
}

const SIDES = new Set(['top', 'right', 'bottom', 'left'])

export function makeContent(part: string) {
  return forwardRef<HTMLDivElement, AnyProps>(function Content(
    {
      children,
      side = 'bottom',
      align = 'center',
      sideOffset = 0,
      forceMount,
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      onInteractOutside,
      onFocusOutside,
      collisionPadding,
      avoidCollisions,
      sticky,
      hideWhenDetached,
      arrowPadding,
      loop,
      ...props
    },
    ref
  ) {
    const ctx = useOverlay(part)
    if (!ctx.open && !forceMount) return null
    const anchor = ctx.anchor ? trackedInstance(ctx.anchor.elementId) : undefined
    if (!anchor) return null
    const s = SIDES.has(side as string) ? (side as 'top') : 'bottom'
    const body = (
      <div
        role={ctx.kind === 'tooltip' ? 'tooltip' : ctx.kind === 'menu' || ctx.kind === 'context' ? 'menu' : 'dialog'}
        data-state="open"
        data-side={s}
        data-align={align}
        {...props}
        ref={ref}
      >
        {children}
      </div>
    )
    return createPortal(
      <anchored
        side={s}
        align={align as 'center'}
        gap={sideOffset as number}
        fit="switch"
        deferred
        style={{ backgroundColor: 'transparent' }}
        onMouseDownOutside={() => ctx.setOpen(false)}
      >
        {body}
      </anchored>,
      anchor as never
    )
  })
}

export function makeItem(closeOnSelect = true) {
  return forwardRef<HTMLDivElement, AnyProps>(function Item({ onSelect, asChild, disabled, children, textValue, ...props }, ref) {
    const ctx = useContext(OverlayCtx)
    const onClick = () => {
      if (disabled) return
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      ;(onSelect as ((e: typeof event) => void) | undefined)?.(event)
      if (closeOnSelect && !event.defaultPrevented) ctx?.setOpen(false)
    }
    const merged = {
      role: 'menuitem',
      'data-disabled': disabled ? '' : undefined,
      ...props,
      onClick,
      ref
    }
    if (asChild) return <Slot {...merged}>{children}</Slot>
    return <div {...merged}>{children}</div>
  })
}

export function passthrough(tag = 'div', defaults: AnyProps = {}) {
  return forwardRef<HTMLDivElement, AnyProps>(function Part({ asChild, children, ...props }, ref) {
    if (asChild) return <Slot {...defaults} {...props} ref={ref}>{children}</Slot>
    const Tag = tag as 'div'
    return (
      <Tag {...defaults} {...props} ref={ref}>
        {children}
      </Tag>
    )
  })
}

export function Close({ asChild, children, ...props }: AnyProps) {
  const ctx = useContext(OverlayCtx)
  const merged = { ...props, onClick: () => ctx?.setOpen(false) }
  if (asChild) return <Slot {...merged}>{children}</Slot>
  return (
    <button type="button" {...merged}>
      {children}
    </button>
  )
}

/** Dialog content: a window-filling layer centring its child. */
export const DialogContent = forwardRef<HTMLDivElement, AnyProps>(function DialogContent(
  { children, onOpenAutoFocus, onCloseAutoFocus, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, forceMount, ...props },
  ref
) {
  const ctx = useOverlay('Dialog.Content')
  const contentRef = useRef(null)
  useEffect(() => {
    if (ctx.open && onOpenAutoFocus) compatWarn('radix-noop', 'Dialog onOpenAutoFocus')
  }, [ctx.open, onOpenAutoFocus])
  if (!ctx.open && !forceMount) return null
  return (
    <anchored fill="window" style={{ backgroundColor: 'transparent' }}>
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div role="dialog" data-state="open" {...props} ref={composeRefs(ref, contentRef)}>
          {children}
        </div>
      </div>
    </anchored>
  )
})

export const DialogOverlay = forwardRef<HTMLDivElement, AnyProps>(function DialogOverlay({ forceMount, ...props }, ref) {
  const ctx = useOverlay('Dialog.Overlay')
  if (!ctx.open && !forceMount) return null
  return (
    <anchored fill="window" style={{ backgroundColor: 'transparent' }}>
      <div data-state="open" {...props} ref={ref} />
    </anchored>
  )
})

export function Provider({ children }: AnyProps) {
  return <>{children}</>
}
