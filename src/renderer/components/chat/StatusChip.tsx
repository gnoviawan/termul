import { createContext, useContext } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * Status chips: one chip per kind of chat activity (subagents, background
 * commands, changes), in a row above the composer. Each chip opens its own
 * panel just above it: a popover on desktop, a bottom sheet on the phone.
 *
 *   <StatusChipRow>
 *     <StatusChip label="Subagent" panelTitle="Subagents" open={…} onOpenChange={…}
 *       trigger={<><Bot /><StatusChipLabel>Subagent</StatusChipLabel>…</>}>
 *       <StatusChipPanelHeader>1 working</StatusChipPanelHeader>
 *       …rows
 *     </StatusChip>
 *   </StatusChipRow>
 */

export type StatusChipTone = 'running' | 'failed' | 'done' | 'idle'

const DOT_TONE: Record<StatusChipTone, string> = {
  running: 'bg-warning',
  failed: 'bg-destructive',
  done: 'bg-success',
  idle: 'bg-muted-foreground'
}

const ChipSurfaceContext = createContext<'popover' | 'sheet'>('popover')

/** The row of chips. Takes the composer's left lane, 8px above the card. */
export function StatusChipRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would give the chips form semantics
    <div
      role="group"
      aria-label="Session status"
      className={cn('flex min-w-0 items-center gap-1.5 pb-2 pl-1', className)}
      {...props}
    />
  )
}

/**
 * Raised chip at rest; hover and open lift the fill a step (a mix toward the
 * ink, so the chip never goes darker than the surface it sits on).
 */
const CHIP_CLASS = cn(
  'group/chip relative inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border-[0.5px] border-border bg-muted pl-2 pr-2.5 text-2xs shadow-xs',
  'transition-[background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
  'hover:bg-[color-mix(in_oklab,oklch(var(--muted)),oklch(var(--foreground))_3%)]',
  'data-[state=open]:border-field-border/40 data-[state=open]:bg-[color-mix(in_oklab,oklch(var(--muted)),oklch(var(--foreground))_6%)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
  // 28px chip, 44px touch target.
  "after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] pointer-coarse:after:-inset-y-2"
)

/** Chip icon slot: muted at rest, ink while its panel is open. */
export const STATUS_CHIP_ICON_CLASS =
  'shrink-0 text-muted-foreground transition-colors duration-150 ease-out group-data-[state=open]/chip:text-foreground motion-reduce:transition-none'

/** Chip word ("Subagent"). Hidden in a narrow pane: icon, count and dot only. */
export function StatusChipLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="font-medium text-foreground @max-[420px]:hidden">{children}</span>
}

export function StatusChipCount({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <span className={cn('tabular-nums text-muted-foreground', className)}>{children}</span>
}

export function StatusChipDot({ tone }: { tone: StatusChipTone }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn('size-1.5 shrink-0 rounded-full', DOT_TONE[tone])}
    />
  )
}

interface StatusChipProps {
  /** Accessible name of the chip: the kind and its counts. */
  label: string
  /** Name of the open panel (dialog). */
  panelTitle: string
  /** Hover hint, for a state the chip cannot show (a wait). */
  hint?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Phone shell: open a bottom sheet in place of the popover. */
  sheet?: boolean
  /** Chip content: icon, label, count, dot. */
  trigger: React.ReactNode
  triggerRef?: React.Ref<HTMLButtonElement>
  /** Skip the focus return to the chip (focus moved on to another sheet). */
  onCloseAutoFocus?: (event: Event) => void
  /** Panel content: header, then rows. */
  children: React.ReactNode
}

/**
 * One chip and its panel. The panel grows from the chip (origin-aware scale
 * and fade, see the menu motion in index.css) and closes on Esc, an outside
 * click or a second click on the chip; focus goes back to the chip.
 */
export function StatusChip({
  label,
  panelTitle,
  hint,
  open,
  onOpenChange,
  sheet = false,
  trigger,
  triggerRef,
  onCloseAutoFocus,
  children
}: StatusChipProps): React.JSX.Element {
  const button = (
    <button ref={triggerRef} type="button" aria-label={label} title={hint} className={CHIP_CLASS}>
      {trigger}
    </button>
  )

  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>{button}</SheetTrigger>
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="flex max-h-[85dvh] flex-col gap-0 overscroll-contain bg-popover p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        >
          <SheetTitle className="flex min-h-11 items-center px-2.5 pr-10 text-sm font-semibold text-foreground">
            {panelTitle}
          </SheetTitle>
          <ChipSurfaceContext.Provider value="sheet">{children}</ChipSurfaceContext.Provider>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        aria-label={panelTitle}
        onCloseAutoFocus={onCloseAutoFocus}
        // Menu dropdown motion: 250ms in from 0.97, 150ms out to 0.99, both on
        // --ease-smooth-out; the origin follows the chip (index.css).
        className="w-[min(24rem,calc(100vw-2rem))] rounded-[10px] border-[0.5px] p-1 shadow-menu data-[state=open]:zoom-in-[var(--scale-medium)] data-[state=closed]:zoom-out-[var(--scale-tiny)]"
      >
        <ChipSurfaceContext.Provider value="popover">{children}</ChipSurfaceContext.Provider>
      </PopoverContent>
    </Popover>
  )
}

/** Panel header: a muted summary on the left, actions on the right. */
export function StatusChipPanelHeader({
  children,
  actions
}: {
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  const surface = useContext(ChipSurfaceContext)
  return (
    <div
      className={cn(
        'flex min-h-8 shrink-0 items-center gap-2 px-2.5 text-2xs text-muted-foreground',
        surface === 'sheet' && 'pb-1'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {actions}
    </div>
  )
}

/** Muted note under the header or the rows. */
export function StatusChipPanelNote({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <p className="px-2.5 pb-1 pt-1 text-2xs text-muted-foreground">{children}</p>
}
