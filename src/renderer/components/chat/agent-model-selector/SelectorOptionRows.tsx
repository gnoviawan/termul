import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from '@/components/icons'
import { AnimatedMenuContent } from '@/components/ui/animated-menu-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * Keyboard focus for rows inside a clipped, scrolling list: the 2px
 * `--focus-ring` edge drawn inset so `overflow-hidden` never cuts it.
 */
export const ROW_FOCUS =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring'

/** A dense 28px row (44px on touch), shared by the list, footer and flyout. */
export const DENSE_ROW = cn(
  'flex w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground',
  'transition-colors duration-150 ease-out hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-60',
  ROW_FOCUS
)

export function denseRowSize(touch: boolean): string {
  return touch ? 'min-h-11' : 'h-7'
}

export interface OptionChoice {
  value: string
  name: string
  description?: string
}

/** Move focus among `selector` matches inside `root` with Up/Down/Home/End. */
export function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  root: HTMLElement | null,
  selector: string
): boolean {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!root || !keys.includes(event.key)) return false
  const all = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled')
  )
  const index = all.indexOf(document.activeElement as HTMLElement)
  // Keys from elsewhere (a portaled flyout bubbles through React) are not ours.
  if (index < 0) return false
  event.preventDefault()
  const last = all.length - 1
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowDown'
          ? Math.min(index + 1, last)
          : Math.max(index - 1, 0)
  all[next]?.focus()
  return true
}

const CHOICE = '[data-option-choice]'

function ChoiceList({
  open,
  label,
  choices,
  value,
  touch,
  onPick,
  onBack
}: {
  /** Focus moves to the checked choice each time the list opens. */
  open: boolean
  label: string
  choices: OptionChoice[]
  value: string | undefined
  touch: boolean
  onPick: (value: string) => void
  onBack: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) focusChoice(ref.current)
  }, [open])
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={cn('flex flex-col', touch ? 'px-3 pb-3' : 'p-1')}
      onKeyDown={(event) => {
        // The flyout is portaled but its keys still bubble through the React
        // tree into the footer and list; keep the ones handled here.
        if (moveFocus(event, ref.current, CHOICE)) {
          event.stopPropagation()
          return
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          onBack()
        }
      }}
    >
      {choices.map((choice) => {
        const selected = choice.value === value
        return (
          <button
            key={choice.value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            data-option-choice=""
            title={choice.description}
            onClick={() => onPick(choice.value)}
            className={cn(DENSE_ROW, denseRowSize(touch))}
          >
            <span className="min-w-0 flex-1 truncate">{choice.name}</span>
            <Check
              size={14}
              aria-hidden="true"
              className={cn('shrink-0', selected ? 'opacity-100' : 'opacity-0')}
            />
          </button>
        )
      })}
    </div>
  )
}

/** Focus the checked choice (or the first) when a flyout opens. */
function focusChoice(container: HTMLElement | null): void {
  const choices = Array.from(container?.querySelectorAll<HTMLElement>(CHOICE) ?? [])
  const target = choices.find((c) => c.getAttribute('aria-checked') === 'true') ?? choices[0]
  target?.focus()
}

/**
 * One session option in the footer, `Effort · High ›`. The value label comes
 * from the option data, so whatever the agent sends (300K, 1M, 256K…) shows.
 * Clicking, Enter or ArrowRight opens its choices beside the row (a bottom
 * sheet on touch). ArrowLeft or Escape closes them and returns focus to the
 * row; Escape closes the flyout before the picker around it.
 */
export function OptionRow({
  id,
  label,
  value,
  choices,
  disabled,
  touch,
  onSelect
}: {
  id: string
  label: string
  value: string | undefined
  choices: OptionChoice[]
  disabled: boolean
  touch: boolean
  onSelect: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const valueName = choices.find((c) => c.value === value)?.name ?? value ?? 'Default'
  const pick = (next: string): void => {
    setOpen(false)
    if (next !== value) onSelect(next)
  }

  const row = (
    <button
      type="button"
      data-option-row=""
      data-testid={`selector-option-${id}`}
      aria-haspopup="menu"
      aria-label={`${label}: ${valueName}`}
      disabled={disabled}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' || touch) return
        event.preventDefault()
        setOpen(true)
      }}
      className={cn(DENSE_ROW, denseRowSize(touch), open && 'bg-row-hover')}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{label}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          {' · '}
        </span>
        <span className="tabular-nums">{valueName}</span>
      </span>
      <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
    </button>
  )

  const list = (
    <ChoiceList
      open={open}
      label={label}
      choices={choices}
      value={value}
      touch={touch}
      onPick={pick}
      onBack={() => setOpen(false)}
    />
  )

  if (touch) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{row}</SheetTrigger>
        <SheetContent
          side="bottom"
          // The list focuses its checked choice itself.
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="flex max-h-[70dvh] flex-col gap-0 border-border bg-popover p-0 pb-[env(safe-area-inset-bottom)] pt-3 [&>button:last-child]:hidden"
        >
          <SheetTitle className="px-5 pb-2 text-sm font-medium">{label}</SheetTitle>
          <SheetDescription className="sr-only">{`Choose ${label}.`}</SheetDescription>
          {list}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{row}</PopoverTrigger>
      <AnimatedMenuContent
        open={open}
        motionPreset="flyout"
        side="right"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        data-testid={`selector-flyout-${id}`}
        contentClassName="z-[110]"
        className="w-44 rounded-lg border-border"
      >
        {list}
      </AnimatedMenuContent>
    </Popover>
  )
}

/** An on/off session option (Fast, or a boolean the agent sends) as one row. */
export function OptionSwitchRow({
  id,
  label,
  checked,
  disabled,
  touch,
  onToggle
}: {
  id: string
  label: string
  checked: boolean
  disabled: boolean
  touch: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 px-2 text-sm', denseRowSize(touch))}>
      <span id={`selector-switch-${id}`} className="min-w-0 flex-1 truncate text-muted-foreground">
        {label}
      </span>
      <Switch
        data-option-row=""
        data-testid={`selector-option-${id}`}
        aria-labelledby={`selector-switch-${id}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onToggle}
        className="scale-90"
      />
    </div>
  )
}
