/**
 * The modal shell Dialog, AlertDialog and Sheet share, on GPUIX's Dialog
 * primitive: a full-window deferred layer, a backdrop whose press closes it
 * (unless the caller says otherwise), focus moved into the popup and back to
 * the trigger, Tab kept inside, Escape through the layer stack.
 *
 * Radix centres a dialog with `fixed left-1/2 top-1/2 -translate-1/2`; GPUIX
 * has no transforms or percentage offsets, so those classes are dropped and
 * the portal centres the popup instead. `grid` (one implicit column) becomes a
 * flex column, which lays out the same.
 */

import type { PublicInstance } from '@gpuix/react'
import * as DialogPrimitive from '@gpuix/react/dialog'
import { createContext, forwardRef, type ReactNode, useContext, useMemo, useRef } from 'react'
import { cn } from '@/lib/utils'
import { dropZeroBasis } from '../../compat/children'
import type { TwState } from '../../style/tw'
import { Box, type HostProps, Inherit, mergeRefs, useTw, wrapText } from './host'
import { useWebviewOcclusion } from './occlusion'
import { bodyText, useControllableState, useFocusFirstTabbable } from './overlay'
import { Slot } from './slot'
import { LAYER } from '../../compat/stacking'

interface ModalState {
  open: boolean
  setOpen(open: boolean): void
  trigger: { current: PublicInstance | null }
}

const ModalContext = createContext<ModalState | null>(null)

export function useModal(part: string): ModalState {
  const modal = useContext(ModalContext)
  if (!modal) throw new Error(`${part} must be inside its dialog Root`)
  return modal
}

export interface ModalRootProps {
  children?: ReactNode
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
}

export function ModalRoot({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  modal = true
}: ModalRootProps) {
  const [current, setCurrent] = useControllableState(open, defaultOpen, onOpenChange)
  const trigger = useRef<PublicInstance | null>(null)
  const value = useMemo(
    () => ({ open: current, setOpen: setCurrent, trigger }),
    [current, setCurrent]
  )
  return (
    <ModalContext.Provider value={value}>
      <DialogPrimitive.Root
        open={current}
        onOpenChange={setCurrent}
        modal={modal}
        disablePointerDismissal
      >
        {children}
      </DialogPrimitive.Root>
    </ModalContext.Provider>
  )
}

export interface PressProps extends HostProps {
  asChild?: boolean
  disabled?: boolean
}

type PressOwnProps = PressProps & { opens: boolean; state?: TwState }

/** A trigger or close part: `<button>`-like, or merged into the `asChild` child. */
export const ModalPress = forwardRef<PublicInstance, PressOwnProps>(function ModalPress(
  { opens, asChild, disabled = false, onClick, state, ...props },
  ref
) {
  const modal = useModal(opens ? 'DialogTrigger' : 'DialogClose')
  const ownRef = opens ? mergeRefs(ref, modal.trigger) : ref
  const press: HostProps['onClick'] = (event) => {
    onClick?.(event)
    if (!event.defaultPrevented && !disabled) modal.setOpen(opens)
  }
  if (asChild)
    return (
      <Slot ref={ownRef} {...props} onClick={press} data-state={modal.open ? 'open' : 'closed'} />
    )
  return (
    <Box
      ref={ownRef}
      role="button"
      tabIndex={disabled ? -1 : 0}
      {...props}
      onClick={press}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (!event.defaultPrevented && event.key === 'Enter') modal.setOpen(opens)
      }}
      state={{ ...state, disabled }}
    />
  )
})

const CENTERING = /^(fixed|left-\[50%\]|top-\[50%\]|translate-[xy]-\[-50%\])$/

/** Drop the transform-centring classes; the portal centres the popup. */
export function centeredClasses(classes: string): string {
  return classes
    .split(/\s+/)
    .filter((token) => !CENTERING.test(token))
    .map((token) => (token === 'grid' ? 'flex flex-col' : token))
    .join(' ')
}

export interface ModalContentProps extends HostProps {
  onEscapeKeyDown?: (event: { preventDefault(): void }) => void
  onPointerDownOutside?: (event: { preventDefault(): void }) => void
  onInteractOutside?: (event: { preventDefault(): void }) => void
  onOpenAutoFocus?: (event: { preventDefault(): void }) => void
  onCloseAutoFocus?: (event: { preventDefault(): void }) => void
}

/** Portal, backdrop and popup. `dismissOnBackdrop` is false for AlertDialog. */
export const ModalContent = forwardRef<
  PublicInstance,
  ModalContentProps & { overlayClassName: string; dismissOnBackdrop: boolean; after?: ReactNode }
>(function ModalContent(
  {
    className,
    overlayClassName,
    dismissOnBackdrop,
    after,
    children,
    style,
    onEscapeKeyDown,
    onPointerDownOutside,
    onInteractOutside,
    onOpenAutoFocus: _onOpenAutoFocus,
    onCloseAutoFocus: _onCloseAutoFocus,
    ...props
  },
  ref
) {
  const modal = useModal('DialogContent')
  useWebviewOcclusion(modal.open)
  const attrs = { ...props, 'data-state': modal.open ? 'open' : 'closed' }
  const overlay = useTw(overlayClassName, {}, attrs).style
  const { style: popupStyle, svgClasses } = useTw(className, {}, attrs)
  const merged = { ...popupStyle, ...style }
  const popup = useRef<PublicInstance | null>(null)
  useFocusFirstTabbable(popup, modal.open)
  if (!modal.open) return null
  const prevented = (handler?: (event: { preventDefault(): void }) => void) => {
    let stop = false
    handler?.({
      preventDefault() {
        stop = true
      }
    })
    return stop
  }
  // GPUIX's portal is an `<anchored>` at priority 0; this layer lifts it to a
  // dialog's (`stacking.ts`). It takes no pointer: the portal does.
  return (
    <anchored fill="window" priority={LAYER.dialog} occlude={false} style={{ backgroundColor: 'transparent' }}>
      <DialogPrimitive.Portal style={bodyText()}>
        <DialogPrimitive.Backdrop
          style={overlay}
          onMouseDown={() => {
            if (!dismissOnBackdrop) return
            if (prevented(onPointerDownOutside) || prevented(onInteractOutside)) return
            modal.setOpen(false)
          }}
        />
        <DialogPrimitive.Popup
          ref={mergeRefs(ref, popup)}
          testId={props['data-testid'] as string | undefined}
          aria-label={props['aria-label'] as string | undefined}
          role={props.role ?? 'dialog'}
          style={merged}
          finalFocus={() => modal.trigger.current ?? true}
          onKeyDown={(event) => {
            if (event.key === 'escape' && prevented(onEscapeKeyDown)) event.preventDefault()
          }}
        >
          <Inherit color={merged.color as string | undefined} svgClasses={svgClasses}>
            {/* The portal centres the popup, so its height is always its content's. */}
            {wrapText(merged.height === undefined ? dropZeroBasis(children) : children)}
            {after}
          </Inherit>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </anchored>
  )
})

/** Header, footer, title and description: plain styled boxes. */
export function part(base: string, role?: string) {
  return forwardRef<PublicInstance, HostProps>(function Part({ className, ...props }, ref) {
    return <Box ref={ref} role={role} {...props} className={cn(base, className)} />
  })
}
