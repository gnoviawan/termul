import {
  AnimatePresence,
  animate,
  motion,
  type Transition,
  useIsPresent,
  useReducedMotion,
  type Variants
} from 'framer-motion'
import {
  type ComponentPropsWithoutRef,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { ArrowLeft, Check, ChevronRight, X } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { FOCUS_RING_CLASS } from './panel-styles'
import { SheetClose, SheetContent, SheetTitle } from './sheet'
import { Switch } from './switch'

const HEADER_BUTTON =
  'flex size-11 items-center justify-center rounded-full text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring'

const ROW_SURFACE = 'bg-foreground/[0.05]'

const ROW_PRESS =
  'transition-colors duration-150 ease-out enabled:active:bg-foreground/[0.06] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:text-disabled-foreground'

export const SUBVIEW_TRIGGER_ATTR = 'data-sheet-subview-trigger'

/** Where a sheet is: the keys of the views pushed above its root, bottom first. */
export interface SheetNav {
  path: readonly string[]
  pop: () => void
}

type Direction = 'push' | 'pop'

const pathId = (path: readonly string[]): string => path.join('\n')

const SLIDE: Transition = { duration: 0.42, ease: [0.32, 0.72, 0, 1] }
const FADE: Transition = { duration: 0.15, ease: 'easeOut' }
const DIM = 0.35

// The view on top slides across the full width; the one beneath moves 30% and dims.
const slide: Variants = {
  enter: (dir: Direction) => (dir === 'push' ? { x: '100%', zIndex: 1 } : { x: '-30%', zIndex: 0 }),
  center: { x: 0 },
  exit: (dir: Direction) => (dir === 'push' ? { x: '-30%', zIndex: 0 } : { x: '100%', zIndex: 1 })
}
const dim: Variants = {
  enter: (dir: Direction) => ({ opacity: dir === 'push' ? 0 : DIM }),
  center: { opacity: 0 },
  exit: (dir: Direction) => ({ opacity: dir === 'push' ? DIM : 0 })
}
const fade: Variants = { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }

/**
 * Which way the sheet moved, from the depth of the view it moves to. Derived
 * in render (the stored-previous-value pattern), so the entering and leaving
 * views read the same direction in the same commit.
 */
function useDirection(path: readonly string[]): Direction {
  const key = pathId(path)
  const [last, setLast] = useState({ key, depth: path.length, direction: 'push' as Direction })
  if (last.key !== key) {
    const next = {
      key,
      depth: path.length,
      direction: (path.length < last.depth ? 'pop' : 'push') as Direction
    }
    setLast(next)
    return next.direction
  }
  return last.direction
}

/**
 * One view of the sheet. A leaving view keeps its last content for the
 * transition but is inert, so focus, taps and screen readers only reach the
 * view the sheet is moving to.
 */
const SheetLayer = forwardRef<
  HTMLDivElement,
  { direction: Direction; reduced: boolean; className?: string; children: ReactNode }
>(function SheetLayer({ direction, reduced, className, children }, ref) {
  const present = useIsPresent()
  return (
    <motion.div
      ref={ref}
      custom={direction}
      variants={reduced ? fade : slide}
      initial="enter"
      animate="center"
      exit="exit"
      transition={reduced ? FADE : SLIDE}
      aria-hidden={present ? undefined : true}
      {...(present ? {} : { inert: '' })}
      className="relative flex min-h-0 flex-1 flex-col bg-popover"
    >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
          className
        )}
      >
        {children}
      </div>
      {reduced ? null : (
        <motion.div
          aria-hidden="true"
          custom={direction}
          variants={dim}
          transition={SLIDE}
          className="pointer-events-none absolute inset-0 bg-overlay"
        />
      )}
    </motion.div>
  )
})

function TitleText({ children }: { children: string }): React.JSX.Element {
  const present = useIsPresent()
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={FADE}
      aria-hidden={present ? undefined : true}
      className="min-w-0 truncate [grid-area:1/1]"
    >
      {children}
    </motion.span>
  )
}

interface MobileSheetContentProps
  extends Omit<ComponentPropsWithoutRef<typeof SheetContent>, 'side' | 'title' | 'closeButton'> {
  title: string
  /** The sheet's view stack; without it the sheet has only its root. */
  nav?: SheetNav
  bodyClassName?: string
}

const NO_PATH: readonly string[] = []

/**
 * A bottom sheet with a header (Close at the root, Back above it) and one
 * scrolling body per view. A push slides the new view in from the right over
 * the dimmed old one; a pop reverses it; the sheet's height follows the view.
 * Reduced motion swaps views with a short fade.
 */
export function MobileSheetContent({
  title,
  nav,
  className,
  bodyClassName,
  children,
  ...props
}: MobileSheetContentProps): React.JSX.Element {
  const path = nav?.path ?? NO_PATH
  const key = path.at(-1) ?? ''
  const depth = path.length
  const contentRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const reduced = useReducedMotion() ?? false
  const direction = useDirection(path)

  // The viewport's height as last laid out. A ResizeObserver reports after the
  // layout effects of a commit, so the route change below still reads the old one.
  const heightRef = useRef<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const viewportCallbackRef = useCallback((viewport: HTMLDivElement | null) => {
    viewportRef.current = viewport
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!viewport) return
    heightRef.current = viewport.offsetHeight
    const observer = new ResizeObserver(() => {
      heightRef.current = viewport.offsetHeight
    })
    observer.observe(viewport)
    observerRef.current = observer
  }, [])

  const previousPath = useRef(path)
  const heightAnimation = useRef<{ stop: () => void } | null>(null)
  useLayoutEffect(() => {
    const previous = previousPath.current
    previousPath.current = path
    if (pathId(previous) === pathId(path)) return

    const viewport = viewportRef.current
    const from = heightRef.current
    if (viewport && from !== null && !reduced) {
      heightAnimation.current?.stop()
      viewport.style.height = ''
      const to = viewport.offsetHeight
      if (to !== from) {
        // The animation starts on the next frame; hold the old height until then.
        viewport.style.height = `${from}px`
        const controls = animate(viewport, { height: [from, to] }, SLIDE)
        heightAnimation.current = controls
        void controls.then(() => {
          if (heightAnimation.current === controls) viewport.style.height = ''
        })
      }
    }

    if (path.length > previous.length) {
      backRef.current?.focus()
      return
    }
    // Back on a view: focus the row that opened the view just left.
    const left = previous[path.length]
    const trigger = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(`[${SUBVIEW_TRIGGER_ATTR}]`) ?? []
    ).find((el) => el.getAttribute(SUBVIEW_TRIGGER_ATTR) === left && !el.closest('[inert]'))
    if (trigger) trigger.focus()
    else if (path.length > 0) backRef.current?.focus()
  }, [path, reduced])

  return (
    <SheetContent
      ref={contentRef}
      side="bottom"
      closeButton={false}
      className={cn(
        'flex max-h-[85dvh] flex-col gap-0 overflow-hidden rounded-t-3xl border-border bg-popover p-0',
        className
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/20"
      />
      <div className="grid shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center px-2 pb-2 pt-1">
        {nav && depth > 0 ? (
          <button
            ref={backRef}
            type="button"
            aria-label="Back"
            className={HEADER_BUTTON}
            onClick={nav.pop}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        ) : (
          <SheetClose className={HEADER_BUTTON}>
            <X size={18} aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        )}
        <SheetTitle className="grid grid-cols-[minmax(0,1fr)] text-center text-base font-semibold">
          <AnimatePresence initial={false}>
            <TitleText key={key}>{title}</TitleText>
          </AnimatePresence>
        </SheetTitle>
      </div>
      <div ref={viewportCallbackRef} className="relative flex min-h-0 flex-col overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <SheetLayer key={key} direction={direction} reduced={reduced} className={bodyClassName}>
            {children}
          </SheetLayer>
        </AnimatePresence>
      </div>
    </SheetContent>
  )
}

/**
 * A sheet's view stack. Routes are the caller's own union; `keyOf` names each
 * one for focus return (`SheetRow`'s `subview`) and for the transition. Every
 * level is its own overlay entry, so Escape and system back pop one level.
 * A fresh open starts at the root.
 */
export function useSheetStack<R>(
  overlayId: string,
  sheetOpen: boolean,
  keyOf: (route: R) => string
): SheetNav & {
  stack: readonly R[]
  top: R | null
  push: (route: R) => void
  reset: () => void
  onEscapeKeyDown: (event: KeyboardEvent) => void
} {
  const [stack, setStack] = useState<readonly R[]>([])
  const [wasOpen, setWasOpen] = useState(sheetOpen)
  if (wasOpen !== sheetOpen) {
    setWasOpen(sheetOpen)
    if (sheetOpen && stack.length > 0) setStack([])
  }
  const push = useCallback((route: R) => setStack((s) => [...s, route]), [])
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const reset = useCallback(() => setStack([]), [])
  useLevelRegistrations(overlayId, sheetOpen ? stack.length : 0, pop)
  const depth = stack.length
  const onEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (depth === 0) return
      event.preventDefault()
      pop()
    },
    [depth, pop]
  )
  const keyOfRef = useRef(keyOf)
  keyOfRef.current = keyOf
  const path = useMemo(() => stack.map((route) => keyOfRef.current(route)), [stack])
  return { stack, top: stack.at(-1) ?? null, path, push, pop, reset, onEscapeKeyDown }
}

/** One overlay entry per pushed level, so each system back pops one level. */
function useLevelRegistrations(overlayId: string, depth: number, pop: () => void): void {
  const popRef = useRef(pop)
  popRef.current = pop
  const registered = useRef(0)
  useEffect(() => {
    const store = useOverlayStackStore.getState()
    while (registered.current < depth) {
      registered.current += 1
      store.registerOverlay(`${overlayId}:subview:${registered.current}`, () => popRef.current())
    }
    while (registered.current > depth) {
      store.unregisterOverlay(`${overlayId}:subview:${registered.current}`)
      registered.current -= 1
    }
  }, [overlayId, depth])
  useEffect(
    () => () => {
      const store = useOverlayStackStore.getState()
      for (; registered.current > 0; registered.current -= 1) {
        store.unregisterOverlay(`${overlayId}:subview:${registered.current}`)
      }
    },
    [overlayId]
  )
}

export function SheetGroup({
  label,
  className,
  children
}: {
  label?: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const labelId = useId()
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would give the rows form semantics
    <div role="group" aria-labelledby={label ? labelId : undefined} className={className}>
      {label ? (
        <h3 id={labelId} className="px-3 pb-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </h3>
      ) : null}
      <div className="flex flex-col gap-px overflow-hidden rounded-2xl">{children}</div>
    </div>
  )
}

export function SheetIconWell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-sm font-medium text-foreground"
    >
      {children}
    </span>
  )
}

type SheetRowProps = {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  value?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  aside?: ReactNode
  'aria-label'?: string
  testId?: string
} & (
  | { accessory?: 'chevron'; subview?: string }
  | { accessory: 'check'; selected: boolean; role?: 'radio' }
)

export function SheetRow(props: SheetRowProps): React.JSX.Element {
  const {
    title,
    subtitle,
    icon,
    value,
    onSelect,
    disabled = false,
    aside,
    'aria-label': ariaLabel,
    testId
  } = props
  const check = props.accessory === 'check' ? props : null
  const subview = props.accessory === 'check' ? undefined : props.subview
  const id = useId()
  const hasValue = value !== undefined && value !== null
  const inner = (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-title`} className="truncate text-sm">
          {title}
        </span>
        {subtitle ? (
          <span id={`${id}-subtitle`} className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      {hasValue ? (
        <span
          id={`${id}-value`}
          className="flex max-w-[45%] shrink-0 items-center gap-1.5 truncate text-sm text-muted-foreground"
        >
          {value}
        </span>
      ) : null}
      {props.accessory === 'chevron' ? (
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      ) : null}
      {check ? (
        <Check
          size={18}
          aria-hidden="true"
          className={cn('shrink-0 text-foreground', check.selected ? 'opacity-100' : 'opacity-0')}
        />
      ) : null}
    </>
  )
  const layout = 'flex min-h-12 min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left'
  const pressed = check
    ? check.role === 'radio'
      ? { 'aria-checked': check.selected }
      : { 'aria-pressed': check.selected }
    : {}
  return (
    <div className={cn('flex min-w-0 items-stretch text-foreground', ROW_SURFACE)}>
      {onSelect ? (
        <button
          type="button"
          role={check?.role}
          aria-label={ariaLabel}
          aria-labelledby={
            ariaLabel ? undefined : hasValue ? `${id}-title ${id}-value` : `${id}-title`
          }
          aria-describedby={subtitle ? `${id}-subtitle` : undefined}
          disabled={disabled}
          onClick={onSelect}
          data-testid={testId}
          {...{ [SUBVIEW_TRIGGER_ATTR]: subview }}
          {...pressed}
          className={cn(layout, ROW_PRESS)}
        >
          {inner}
        </button>
      ) : (
        <div data-testid={testId} className={layout}>
          {inner}
        </div>
      )}
      {aside}
    </div>
  )
}

export function SheetSwitchRow({
  title,
  subtitle,
  icon,
  checked,
  disabled = false,
  onCheckedChange,
  testId
}: {
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  testId?: string
}): React.JSX.Element {
  const id = useId()
  return (
    <div
      className={cn('flex min-h-12 items-center gap-3 px-4 py-2.5 text-foreground', ROW_SURFACE)}
    >
      {icon}
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
        <span className="truncate text-sm">{title}</span>
        {subtitle ? (
          <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </label>
      <Switch
        id={id}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

/**
 * A sheet's search field. It never takes focus on its own: a focused field
 * raises the keyboard over the list.
 */
export function SheetSearchField({
  value,
  onChange,
  placeholder,
  label
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
}): React.JSX.Element {
  return (
    <input
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className={cn(
        'h-11 w-full shrink-0 rounded-xl bg-foreground/[0.05] px-4 text-base text-foreground placeholder:text-muted-foreground',
        FOCUS_RING_CLASS
      )}
    />
  )
}
