import {
  type KeyboardEvent,
  type MutableRefObject,
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
import { Switch, switchClasses } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { editButtonAccessibleName } from './selector-model'
import {
  PICKER_EDIT_MOTION,
  PICKER_ICON,
  PICKER_LABEL,
  PICKER_ROW,
  PICKER_ROW_SELECTED_BOX,
  PICKER_ROW_VALUE,
  PICKER_SURFACE,
  pickerRowHeight
} from './selector-tokens'
import { REJECTED_TITLE, useOptimisticSwitch } from './use-option-values'

/**
 * Keyboard focus for rows inside a clipped, scrolling list: the 2px
 * `--focus-ring` edge drawn inset so `overflow-hidden` never cuts it.
 */
export const ROW_FOCUS =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring'

/** A dense 28px row (44px on touch), shared by the list, footer and flyout. */
export const DENSE_ROW = cn(
  'flex w-full items-center text-left text-foreground',
  PICKER_ROW.text,
  PICKER_ROW.gap,
  PICKER_ROW.padX,
  PICKER_ROW.radius,
  'transition-colors duration-150 ease-out hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-60',
  ROW_FOCUS
)

export const denseRowSize = pickerRowHeight

/**
 * A flyout's surface: the panel's radius, border and shadow, as wide as its
 * longest choice but never under 180px.
 */
const FLYOUT_SURFACE = cn('min-w-45 max-w-64 border-border', PICKER_SURFACE.radius)

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

/**
 * The current Thinking level's label, read from the flyout's own Thinking
 * section so the Edit button and the flyout can never disagree. Undefined
 * when the model has no thinking option or no current value is known: never
 * a guessed default.
 */
export function thinkingLabel(sections: readonly ChoiceSection[]): string | undefined {
  const section = sections.find((s) => s.id === 'thinking')
  if (section?.kind !== 'radio' || section.value === undefined) return undefined
  return section.choices.find((choice) => choice.value === section.value)?.name
}

/** The look of `Switch`, for an item that is itself the control. */
function SwitchMark({ on }: { on: boolean }): React.JSX.Element {
  const state = on ? 'checked' : 'unchecked'
  const { track, thumb } = switchClasses('sm')
  return (
    <span aria-hidden="true" data-state={state} data-switch-size="sm" className={track}>
      <span data-state={state} className={thumb} />
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
      className={cn(
        'flex flex-col',
        PICKER_ROW.text,
        touch ? PICKER_SURFACE.paddingTouch : PICKER_SURFACE.padding
      )}
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
            <div key={section.id} className="flex flex-col">
              {index > 0 ? (
                <hr className={cn('my-1', PICKER_SURFACE.separator, touch ? '-mx-3' : '-mx-1')} />
              ) : null}
              <ToggleChoice section={section} touch={touch} />
            </div>
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
                size={PICKER_ICON.check}
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
            <div id={headingId} className={PICKER_LABEL}>
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
  touch
}: {
  section: Extract<ChoiceSection, { kind: 'toggle' }>
  touch: boolean
}): React.JSX.Element {
  const [on, toggle] = useOptimisticSwitch(section.checked, section.onToggle)
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      data-option-choice=""
      onClick={() => toggle(!on)}
      className={cn(DENSE_ROW, denseRowSize(touch))}
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
        className={FLYOUT_SURFACE}
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
    <div
      className={cn(
        'flex items-center',
        PICKER_ROW.gap,
        PICKER_ROW.padX,
        PICKER_ROW.text,
        denseRowSize(touch)
      )}
    >
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

/** The box around a row and its Edit; the row's hover fills both. */
export const EDIT_ROW_BOX =
  'flex min-w-0 items-center rounded-md transition-colors duration-150 ease-out hover:bg-row-hover'

/** Edit's own box, shared by the button and the copy a pick leaves behind. */
function editBox(touch: boolean): string {
  return cn(
    // 2px less on the chevron side so the label and chevron look centred.
    'group/edit flex shrink-0 items-center gap-0.5 rounded-md pl-1.5 pr-1 text-xs',
    touch ? 'min-h-11' : 'h-7'
  )
}

/** What Edit shows: the Thinking level, or "Edit" when there is none. */
export interface EditFace {
  level: string | undefined
}

/**
 * Edit's motion on one row. `face` is what the row's Edit shows, or null with
 * no Edit. Edit enters only when it arrives after the row's first render (a
 * pick), never on the panel's first paint. When it goes, `exiting` keeps what
 * it showed until its fade ends. Reduced motion: neither.
 */
export function useEditMotion(
  face: EditFace | null,
  reduced: boolean
): { entering: boolean; exiting: EditFace | null } {
  const [last, setLast] = useState(face)
  const [entering, setEntering] = useState(false)
  const [exiting, setExiting] = useState<EditFace | null>(null)
  if ((face === null) !== (last === null) || face?.level !== last?.level) {
    // Set while rendering, so the pick's first frame already has it: the old
    // Edit is never in the tree as a live button beside the new one.
    setLast(face)
    if (face && !last) {
      setEntering(!reduced)
      setExiting(null)
    } else if (!face && last) {
      setEntering(false)
      setExiting(reduced ? null : last)
    }
  }
  useEffect(() => {
    if (!exiting) return
    const timer = setTimeout(() => setExiting(null), PICKER_EDIT_MOTION.exitMs)
    return () => clearTimeout(timer)
  }, [exiting])
  return { entering, exiting: face ? null : exiting }
}

/** React 18 has no `inert` prop; an empty string renders the attribute. */
const INERT = { inert: '' } as Record<string, string>

/**
 * The look of Edit, left beside the old row by a pick while it fades out.
 * Inert and hidden from its first frame: no focus, no click, no flyout, and
 * the row beside it is already the plain unselected row.
 */
export function ExitingEdit({
  face,
  touch
}: {
  face: EditFace
  touch: boolean
}): React.JSX.Element {
  return (
    <span
      data-edit-exiting=""
      aria-hidden="true"
      {...INERT}
      className={cn(editBox(touch), 'text-muted-foreground', PICKER_EDIT_MOTION.exit)}
    >
      {face.level ? <span className={PICKER_ROW_VALUE}>{face.level}</span> : 'Edit'}
      <ChevronRight size={12} aria-hidden="true" />
    </span>
  )
}

export interface EditRowHandle {
  ref: RefObject<HTMLButtonElement>
  open: boolean
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  /**
   * Set just before the closing flyout hands focus back to the row, so the row's
   * tooltip does not pop up on that focus (Escape then closes the picker, not a
   * tooltip). The row clears it on the next pointer move or enter, or on blur.
   */
  suppressNextTooltip: MutableRefObject<boolean>
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
  selected = false,
  inFavorites = false,
  entering = false,
  sections,
  disabled,
  touch,
  renderRow
}: {
  modelName: string
  /** The selected model: the box takes the selected fill, over hover and the open flyout. */
  selected?: boolean
  /** The row is the Favorites copy: Edit's name says so. */
  inFavorites?: boolean
  /** A pick just made this row the active one: Edit slides in as it mounts. */
  entering?: boolean
  sections: ChoiceSection[]
  disabled: boolean
  touch: boolean
  renderRow: (row: EditRowHandle) => ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const clickedAway = useRef(false)
  const suppressNextTooltip = useRef(false)
  const what = sectionsLabel(sections)
  // The button shows the current level when there is one, else "Edit".
  const level = thinkingLabel(sections)
  // Focus back on the row from the flyout: quietly, without the row's tooltip.
  const focusRow = (): void => {
    const row = rowRef.current
    if (!row || document.activeElement === row) return
    suppressNextTooltip.current = true
    row.focus()
  }
  const backToRow = (): void => {
    setOpen(false)
    focusRow()
  }

  const edit = (
    <button
      type="button"
      data-testid="selector-edit"
      aria-label={editButtonAccessibleName({
        name: modelName,
        thinking: level,
        sections: what,
        inFavorites
      })}
      // The flyout is a Popover (a sheet on touch): a dialog holding the menu.
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      data-entering={entering ? '' : undefined}
      className={cn(
        editBox(touch),
        entering ? PICKER_EDIT_MOTION.enter : 'transition-colors duration-150 ease-out',
        'disabled:cursor-not-allowed disabled:opacity-60',
        // On the selected fill muted ink drops under 4.5:1 (dark); secondary keeps it.
        open
          ? 'text-foreground'
          : cn(
              selected ? 'text-secondary-foreground' : 'text-muted-foreground',
              'hover:text-foreground'
            ),
        ROW_FOCUS
      )}
    >
      {level ? (
        <span
          data-edit-thinking=""
          className={cn(
            PICKER_ROW_VALUE,
            open
              ? 'text-foreground'
              : cn(selected && 'text-secondary-foreground', 'group-hover/edit:text-foreground')
          )}
        >
          {level}
        </span>
      ) : (
        'Edit'
      )}
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  )
  const row = (trigger: ReactNode): React.JSX.Element => (
    <div
      data-row-selected={selected ? '' : undefined}
      // `group/fav`: hovering Edit still shows the row's star.
      className={cn(
        'group/fav',
        EDIT_ROW_BOX,
        open && 'bg-row-hover',
        selected && PICKER_ROW_SELECTED_BOX
      )}
    >
      {renderRow({
        ref: rowRef,
        open,
        suppressNextTooltip,
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
        onEscapeKeyDown={focusRow}
        onInteractOutside={() => {
          clickedAway.current = true
        }}
        // Back to the row, not the Edit trigger; a click elsewhere keeps its own focus.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!clickedAway.current) focusRow()
          clickedAway.current = false
        }}
        data-testid="selector-edit-flyout"
        contentClassName="z-[110]"
        className={FLYOUT_SURFACE}
      >
        {list}
      </AnimatedMenuContent>
    </Popover>
  )
}
