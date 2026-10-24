/**
 * Radix-style floating layers on GPUIX's `<anchored>`.
 *
 * A Root owns `open` (controlled or not) and the trigger instance. Content is
 * portalled into the trigger and placed by a deferred `<anchored>`, so it
 * paints above everything, follows the trigger, and flips to the other side
 * when it would leave the window (`fit="switch"`, Radix's collision flip).
 * Unlike GPUIX's own primitives, no wrapper `div` is added around the trigger,
 * so the trigger keeps its place in the caller's layout.
 *
 * Dismissal joins GPUIX's layer stack (`DismissableLayer`): Escape closes only
 * the top layer, focus moves into the content on open and back to the trigger
 * on close. A press outside both the content and the trigger closes it.
 */
import {
  createPortal,
  DismissableLayer,
  type EventPayload,
  type PublicInstance,
  type StyleDesc,
  useGpuix
} from '@gpuix/react'
import {
  type Context,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { tw } from '../../style/tw'
import { SANS_FAMILY } from '../../style/utilities'

/** index.css `body`: `font-sans text-foreground`, 16px/24px, weight 400. */
export function bodyText(): StyleDesc {
  return {
    ...tw('text-foreground'),
    fontFamily: SANS_FAMILY,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 400,
    textAlign: 'left',
    whiteSpace: 'normal'
  }
}

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Align = 'start' | 'center' | 'end'

export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void
): [T, (value: T) => void] {
  const [internal, setInternal] = useState(defaultValue)
  const controlled = value !== undefined
  const current = controlled ? value : internal
  const latest = useRef(current)
  latest.current = current
  const set = useCallback(
    (next: T) => {
      if (Object.is(latest.current, next)) return
      latest.current = next
      if (!controlled) setInternal(next)
      onChange?.(next)
    },
    [controlled, onChange]
  )
  return [current, set]
}

/** How an overlay was opened; menus highlight their first item only for the keyboard. */
export type OpenReason = 'pointer' | 'keyboard' | 'programmatic'

export interface OverlayState {
  open: boolean
  setOpen(open: boolean, reason?: OpenReason): void
  /** Ref of the open state, current within the same event (before React re-renders). */
  openRef: { readonly current: boolean }
  openReason: OpenReason
  trigger: PublicInstance | null
  setTrigger(instance: PublicInstance | null): void
}

export function useOverlayState({
  open,
  defaultOpen = false,
  onOpenChange
}: {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}): OverlayState {
  const [current, setCurrent] = useControllableState(open, defaultOpen, onOpenChange)
  const [trigger, setTrigger] = useState<PublicInstance | null>(null)
  const [openReason, setOpenReason] = useState<OpenReason>('programmatic')
  const openRef = useRef(current)
  openRef.current = current
  const setOpen = useCallback(
    (next: boolean, reason: OpenReason = 'programmatic') => {
      openRef.current = next
      if (next) setOpenReason(reason)
      setCurrent(next)
    },
    [setCurrent]
  )
  return useMemo(
    () => ({ open: current, setOpen, openRef, openReason, trigger, setTrigger }),
    [current, setOpen, openReason, trigger]
  )
}

export type OverlayKind = 'menu' | 'popover' | 'tooltip' | 'select'

/**
 * One context per primitive, as Radix scopes them: a Tooltip wrapped around a
 * DropdownMenuTrigger must not hide the menu's Root from the trigger.
 */
export const OverlayContext: Record<OverlayKind, Context<OverlayState | null>> = {
  menu: createContext<OverlayState | null>(null),
  popover: createContext<OverlayState | null>(null),
  tooltip: createContext<OverlayState | null>(null),
  select: createContext<OverlayState | null>(null)
}

export function useOverlay(kind: OverlayKind, part: string): OverlayState {
  const overlay = useContext(OverlayContext[kind])
  if (!overlay) throw new Error(`${part} must be used inside its Root`)
  return overlay
}

function inside(
  bounds: { x: number; y: number; width: number; height: number } | null,
  event: EventPayload
) {
  if (!bounds || event.x === undefined || event.y === undefined) return false
  return (
    event.x >= bounds.x &&
    event.x < bounds.x + bounds.width &&
    event.y >= bounds.y &&
    event.y < bounds.y + bounds.height
  )
}

/** Frames to wait before the tab order exists: GPUI builds it while painting. */
const TAB_ORDER_DELAY_MS = 32

/**
 * Radix FocusScope's auto focus: once the layer has painted, move focus from
 * the container to its first tabbable element, if it has one.
 */
export function useFocusFirstTabbable(
  container: { readonly current: PublicInstance | null },
  enabled: boolean
) {
  const { renderer } = useGpuix()
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => {
      const id = container.current?.id
      if (id !== undefined && renderer?.getFocusedElementId?.() === id)
        renderer?.focusNextWithin?.(id)
    }, TAB_ORDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [container, enabled, renderer])
}

/** An open layer and the layers opened from inside it (a sub-menu, a Select in a Popover). */
export interface LayerNode {
  content: { readonly current: PublicInstance | null }
  children: Set<LayerNode>
}

const LayerContext = createContext<LayerNode | null>(null)

/**
 * Outside-press dismissal for one layer. A press counts as outside when it
 * misses the content, the trigger (which toggles on its own) and every layer
 * opened from inside this one, as Radix's nested DismissableLayers behave.
 */
export function useLayer(
  overlay: OverlayState,
  content: { readonly current: PublicInstance | null },
  onOutside: (event: EventPayload) => void
): { node: LayerNode; onMouseDownOutside(event: EventPayload): void } {
  const { renderer } = useGpuix()
  const parent = useContext(LayerContext)
  const node = useMemo<LayerNode>(() => ({ content, children: new Set() }), [content])
  useLayoutEffect(() => {
    if (!parent) return
    parent.children.add(node)
    return () => {
      parent.children.delete(node)
    }
  }, [parent, node])
  const hits = (instance: PublicInstance | null, event: EventPayload) =>
    instance !== null && inside(renderer?.getElementBounds?.(instance.id) ?? null, event)
  const inChild = (layer: LayerNode, event: EventPayload): boolean =>
    [...layer.children].some((child) => hits(child.content.current, event) || inChild(child, event))
  return {
    node,
    onMouseDownOutside(event) {
      if (hits(overlay.trigger, event) || inChild(node, event)) return
      onOutside(event)
    }
  }
}

export interface FloatingProps {
  overlay: OverlayState
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  /** Flip to the opposite side when the content would leave the window (default true). */
  avoidCollisions?: boolean
  /** Window point to open at instead of the trigger (context menus). */
  position?: { x: number; y: number }
  /** Paint order among deferred layers; later layers (submenus) pass a higher one. */
  priority?: number
  /** Escape or a layer-stack dismissal. */
  onDismiss(): void
  /** Focus the content on open (menus, popovers), or leave focus (tooltips). */
  focusContent?: () => number | null
  /** Where focus goes on close. Default: the trigger, else the focus from before. */
  returnFocus?: boolean
  /** The layer node from `useLayer`, so layers opened inside this one register under it. */
  layer?: LayerNode
  children: ReactNode
}

/** The anchored layer, portalled into the trigger (or at a window point). */
export function Floating({
  overlay,
  side = 'bottom',
  align = 'center',
  sideOffset = 0,
  alignOffset = 0,
  avoidCollisions = true,
  position,
  priority = 1,
  onDismiss,
  focusContent,
  returnFocus = true,
  layer,
  children
}: FloatingProps): ReactNode {
  const triggerId = overlay.trigger?.id ?? null
  const offset =
    side === 'top' || side === 'bottom' ? { x: alignOffset, y: 0 } : { x: 0, y: alignOffset }
  // The layer sits inside the trigger in GPUI's tree, so it would inherit the
  // trigger's text style; a Radix portal inherits the body's instead.
  const surface: StyleDesc = { backgroundColor: 'transparent', ...bodyText() }
  const element = (
    <DismissableLayer
      onEscapeKeyDown={onDismiss}
      initialFocus={() => focusContent?.() ?? null}
      finalFocus={(previous) => (returnFocus ? (triggerId ?? previous) : null)}
    >
      <anchored
        side={side}
        align={align}
        gap={sideOffset}
        offset={offset}
        position={position}
        fit={avoidCollisions ? 'switch' : 'snap'}
        deferred
        priority={priority}
        style={surface}
        // The layer sits inside the trigger in GPUI's tree, but belongs to the
        // Root in React's: keys typed in it must not reach the trigger.
        onKeyDown={(event) => event.stopPropagation()}
      >
        {layer ? <LayerContext.Provider value={layer}>{children}</LayerContext.Provider> : children}
      </anchored>
    </DismissableLayer>
  )
  if (position) return element
  if (!overlay.trigger) return null
  return createPortal(element, overlay.trigger)
}
