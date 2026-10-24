import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import { Check, ChevronRight } from '@/components/icons'
import { AnimatedMenuContent } from '@/components/ui/animated-menu-content'
import { Popover, PopoverAnchor, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { REJECTED_TITLE, useOptimisticSwitch } from './use-option-values'

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
  /** The agent rejected this value: shown disabled, and only while it is current. */
  unavailable?: boolean
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

/** One section of a flyout: radio choices, or a single on/off item. */
export type ChoiceSection =
  | {
      kind: 'radio'
      id: string
      label: string
      value: string | undefined
      choices: OptionChoice[]
      onPick: (value: string) => void
    }
  | {
      kind: 'toggle'
      id: string
      label: string
      /** Drawn beside the switch. */
      icon?: ReactNode
      checked: boolean
      onToggle: (value: boolean) => void | Promise<void>
    }

/** `Thinking, Context and Fast mode` */
export function sectionsLabel(sections: readonly ChoiceSection[]): string {
  const labels = sections.map((section) => section.label)
  const last = labels.pop()
  return labels.length > 0 ? `${labels.join(', ')} and ${last}` : (last ?? '')
}

/** The look of `Switch`, for an item that is itself the control. */
function SwitchMark({ on }: { on: boolean }): React.JSX.Element {
  const state = on ? 'checked' : 'unchecked'
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className="switch-track inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-150 ease-out"
    >
      <span
        data-state={state}
        className="switch-thumb block size-4 rounded-full transition-transform duration-150 ease-out motion-reduce:transition-none data-[state=checked]:translate-x-4"
      />
    </span>
  )
}

/**
 * A flyout's choices as one menu. A lone radio section takes the menu's
 * label; with more sections each radio set is a labelled group and a toggle
 * is one checkbox item. Up/Down runs across all of them.
 */
export function ChoiceList({
  open,
  label,
  sections,
  touch,
  onBack
}: {
  /** Focus moves to the first checked choice each time the list opens. */
  open: boolean
  label: string
  sections: ChoiceSection[]
  touch: boolean
  onBack: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const baseId = useId()
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
        // tree into the list and footer; keep the ones handled here.
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
      {sections.map((section, index) => {
        if (section.kind === 'toggle') {
          return (
            <ToggleChoice key={section.id} section={section} touch={touch} divided={index > 0} />
          )
        }
        const items = section.choices.map((choice) => {
          const selected = choice.value === section.value
          return (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-label={choice.unavailable ? `${choice.name} — ${REJECTED_TITLE}` : undefined}
              disabled={choice.unavailable}
              data-option-choice=""
              title={choice.unavailable ? REJECTED_TITLE : choice.description}
              onClick={() => section.onPick(choice.value)}
              className={cn(DENSE_ROW, denseRowSize(touch))}
            >
              <span className="min-w-0 flex-1 truncate tabular-nums">{choice.name}</span>
              {choice.unavailable ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">Not available</span>
              ) : null}
              <Check
                size={14}
                aria-hidden="true"
                className={cn('shrink-0', selected ? 'opacity-100' : 'opacity-0')}
              />
            </button>
          )
        })
        if (sections.length === 1) return items
        const headingId = `${baseId}-${section.id}`
        return (
          <fieldset key={section.id} aria-labelledby={headingId} className="flex min-w-0 flex-col">
            <div
              id={headingId}
              className={cn(
                'truncate px-2 pb-1 text-xs text-muted-foreground',
                index > 0 ? 'pt-2' : 'pt-1'
              )}
            >
              {section.label}
            </div>
            {items}
          </fieldset>
        )
      })}
    </div>
  )
}

/** A flyout's on/off item; flips at once and reverts if the agent rejects it. */
function ToggleChoice({
  section,
  touch,
  divided
}: {
  section: Extract<ChoiceSection, { kind: 'toggle' }>
  touch: boolean
  divided: boolean
}): React.JSX.Element {
  const [on, toggle] = useOptimisticSwitch(section.checked, section.onToggle)
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      data-option-choice=""
      onClick={() => toggle(!on)}
      className={cn(
        DENSE_ROW,
        denseRowSize(touch),
        divided && 'mt-1 rounded-t-none border-t border-border'
      )}
    >
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      {section.icon}
      <SwitchMark on={on} />
    </button>
  )
}

/** Focus the first checked radio choice (or the first item) when a flyout opens. */
function focusChoice(container: HTMLElement | null): void {
  // A checked value the agent has since rejected is disabled and cannot take focus.
  const choices = Array.from(container?.querySelectorAll<HTMLElement>(CHOICE) ?? []).filter(
    (c) => !c.hasAttribute('disabled')
  )
  const target =
    choices.find(
      (c) => c.getAttribute('role') === 'menuitemradio' && c.getAttribute('aria-checked') === 'true'
    ) ?? choices[0]
  target?.focus()
}

/**
 * One session option in the footer, `Mode · Agent ›`. The value label comes
 * from the option data, so whatever the agent sends shows.
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
  const section: ChoiceSection = {
    kind: 'radio',
    id,
    label,
    value,
    choices,
    onPick: (next) => {
      setOpen(false)
      if (next !== value) onSelect(next)
    }
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
      sections={[section]}
      touch={touch}
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
        align="start"
        // Line the first choice up with the row (the list has 4px padding).
        alignOffset={-4}
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

/**
 * An on/off session option (Fast, or a boolean the agent sends) as one row.
 * It flips at once and reverts if the agent rejects the change.
 */
export function OptionSwitchRow({
  id,
  label,
  icon,
  checked,
  disabled,
  touch,
  onToggle
}: {
  id: string
  label: string
  /** Drawn beside the switch. */
  icon?: ReactNode
  checked: boolean
  disabled: boolean
  touch: boolean
  onToggle: (value: boolean) => void | Promise<void>
}): React.JSX.Element {
  const [on, toggle] = useOptimisticSwitch(checked, onToggle)
  return (
    <div className={cn('flex items-center gap-2 px-2 text-sm', denseRowSize(touch))}>
      <label
        htmlFor={`selector-switch-${id}`}
        className="min-w-0 flex-1 cursor-pointer truncate text-muted-foreground"
      >
        {label}
      </label>
      {icon}
      <Switch
        id={`selector-switch-${id}`}
        data-option-row=""
        data-testid={`selector-option-${id}`}
        checked={on}
        disabled={disabled}
        onCheckedChange={toggle}
      />
    </div>
  )
}

export interface EditRowHandle {
  ref: RefObject<HTMLButtonElement>
  open: boolean
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

/**
 * The active model's row with an Edit button on its right, after volt's
 * picker. Edit, or ArrowRight on the row, opens the model's session options
 * (Thinking, Context, Fast) beside the row; a bottom sheet on touch.
 * ArrowLeft or Escape closes them and returns focus to the row; Escape
 * closes the flyout before the picker around it.
 */
export function EditableRow({
  modelName,
  sections,
  disabled,
  touch,
  renderRow
}: {
  modelName: string
  sections: ChoiceSection[]
  disabled: boolean
  touch: boolean
  renderRow: (row: EditRowHandle) => ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const clickedAway = useRef(false)
  const what = sectionsLabel(sections)
  const backToRow = (): void => {
    setOpen(false)
    rowRef.current?.focus()
  }

  const edit = (
    <button
      type="button"
      data-testid="selector-edit"
      aria-label={`Edit ${what} for ${modelName}`}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      className={cn(
        // 2px less on the chevron side so the label and chevron look centred.
        'flex shrink-0 items-center gap-0.5 rounded-md pl-1.5 pr-1 text-xs transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60',
        open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        touch ? 'min-h-11' : 'h-7',
        ROW_FOCUS
      )}
    >
      Edit
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  )
  const row = (trigger: ReactNode): React.JSX.Element => (
    <div
      className={cn(
        'flex items-center rounded-md transition-colors duration-150 ease-out hover:bg-row-hover',
        open && 'bg-row-hover'
      )}
    >
      {renderRow({
        ref: rowRef,
        open,
        onKeyDown: (event) => {
          if (event.key !== 'ArrowRight' || touch || disabled) return
          event.preventDefault()
          setOpen(true)
        }
      })}
      {trigger}
    </div>
  )
  const list = (
    <ChoiceList open={open} label={what} sections={sections} touch={touch} onBack={backToRow} />
  )

  if (touch) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {row(<SheetTrigger asChild>{edit}</SheetTrigger>)}
        <SheetContent
          side="bottom"
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="flex max-h-[70dvh] flex-col gap-0 border-border bg-popover p-0 pb-[env(safe-area-inset-bottom)] pt-3 [&>button:last-child]:hidden"
        >
          <SheetTitle className="truncate px-5 pb-2 text-sm font-medium">{modelName}</SheetTitle>
          <SheetDescription className="sr-only">{`Set ${what}.`}</SheetDescription>
          {list}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{row(<PopoverTrigger asChild>{edit}</PopoverTrigger>)}</PopoverAnchor>
      <AnimatedMenuContent
        open={open}
        motionPreset="flyout"
        side="right"
        align="start"
        // Line the first item up with the row (the list has 4px padding).
        alignOffset={-4}
        sideOffset={8}
        collisionPadding={8}
        // The list focuses its checked choice itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => rowRef.current?.focus()}
        onInteractOutside={() => {
          clickedAway.current = true
        }}
        // Back to the row, not the Edit trigger; a click elsewhere keeps its own focus.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!clickedAway.current) rowRef.current?.focus()
          clickedAway.current = false
        }}
        data-testid="selector-edit-flyout"
        contentClassName="z-[110]"
        className="w-44 rounded-lg border-border"
      >
        {list}
      </AnimatedMenuContent>
    </Popover>
  )
}
