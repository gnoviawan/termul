import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { ArrowLeft, Check, ChevronRight, X } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { SheetClose, SheetContent, SheetTitle } from './sheet'
import { Switch } from './switch'

const HEADER_BUTTON =
  'flex size-11 items-center justify-center rounded-full text-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring'

const ROW_SURFACE = 'bg-foreground/[0.05]'

const ROW_PRESS =
  'transition-colors duration-150 ease-out enabled:active:bg-foreground/[0.06] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:text-disabled-foreground'

export const SUBVIEW_TRIGGER_ATTR = 'data-sheet-subview-trigger'

interface MobileSheetContentProps
  extends Omit<ComponentPropsWithoutRef<typeof SheetContent>, 'side' | 'title' | 'closeButton'> {
  title: string
  onBack?: () => void
  view?: string | null
  toolbar?: ReactNode
  bodyClassName?: string
}

export function MobileSheetContent({
  title,
  onBack,
  view = null,
  toolbar,
  className,
  bodyClassName,
  children,
  ...props
}: MobileSheetContentProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const previousView = useRef<string | null>(view)
  useLayoutEffect(() => {
    const previous = previousView.current
    previousView.current = view
    if (previous === view) return
    if (view !== null) {
      backRef.current?.focus()
      return
    }
    const trigger = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>(`[${SUBVIEW_TRIGGER_ATTR}]`) ?? []
    ).find((el) => el.getAttribute(SUBVIEW_TRIGGER_ATTR) === previous)
    trigger?.focus()
  }, [view])

  return (
    <SheetContent
      ref={contentRef}
      side="bottom"
      closeButton={false}
      className={cn(
        'flex max-h-[85dvh] flex-col gap-0 rounded-t-3xl border-border bg-popover p-0',
        className
      )}
      {...props}
    >
      <div
        aria-hidden="true"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/20"
      />
      <div className="grid shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center px-2 pb-2 pt-1">
        {onBack ? (
          <button
            ref={backRef}
            type="button"
            aria-label="Back"
            className={HEADER_BUTTON}
            onClick={onBack}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        ) : (
          <SheetClose className={HEADER_BUTTON}>
            <X size={18} aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        )}
        <SheetTitle className="truncate text-center text-base font-semibold">{title}</SheetTitle>
      </div>
      {toolbar}
      <div
        data-mobile-sheet-body=""
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
          bodyClassName
        )}
      >
        {children}
      </div>
    </SheetContent>
  )
}

export function useSheetSubview<T extends string>(
  overlayId: string,
  sheetOpen: boolean
): {
  view: T | null
  open: (view: T) => void
  back: () => void
  onEscapeKeyDown: (event: KeyboardEvent) => void
} {
  const [view, setView] = useState<T | null>(null)
  const back = useCallback(() => setView(null), [])
  useEffect(() => {
    if (!sheetOpen) setView(null)
  }, [sheetOpen])
  useOverlayRegistration(`${overlayId}:subview`, sheetOpen && view !== null, back)
  const onEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (view === null) return
      event.preventDefault()
      setView(null)
    },
    [view]
  )
  return { view, open: setView, back, onEscapeKeyDown }
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
