import { motion, useReducedMotion } from 'framer-motion'
import { type KeyboardEvent, type MouseEvent, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronRight,
  Regex,
  Replace,
  ReplaceAll,
  type TermulIcon,
  WholeWord,
  X
} from '@/components/icons'
import { withShortcut } from '@/components/shell/use-shortcut-label'
import {
  BAND_FOCUS_CLASS,
  FOCUS_RING_CLASS,
  INNER_FIELD_FOCUS_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isMac } from '@/lib/platform'
import { cn } from '@/lib/utils'

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

/** The count slot. `current` is 1-based, or 0 when the selection is not on a match. */
export type FindStatus =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'matches'; current: number; total: number; capped: boolean }

export interface FindReplaceProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onValueChange: (value: string) => void
  onReplace: () => void
  onReplaceAll: () => void
}

interface FindWidgetProps {
  search: string
  onSearchChange: (value: string) => void
  options: FindOptions
  onOptionsChange: (options: FindOptions) => void
  status: FindStatus
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
  /** Omit where nothing can be replaced (read-only text, terminal output). */
  replace?: FindReplaceProps
  /** Runs before the widget's own keys; return true when the key was handled. */
  onKeyDown?: (event: globalThis.KeyboardEvent) => boolean
  /** Placement: the widget positions nothing itself. */
  className?: string
}

const KEY_NAMES: Record<string, string> = isMac
  ? { mod: '⌘', alt: '⌥', shift: '⇧' }
  : { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' }

/** "Alt+C" on Windows and Linux, "⌥C" on macOS, matching the app's shortcut labels. */
export function findShortcut(...keys: string[]): string {
  return keys.map((key) => KEY_NAMES[key] ?? key).join(isMac ? '' : '+')
}

/** VS Code's option keys: Alt+C, Alt+W, Alt+R. */
const OPTION_TOGGLES: ReadonlyArray<{
  option: keyof FindOptions
  label: string
  icon: TermulIcon
  key: string
}> = [
  { option: 'caseSensitive', label: 'Match case', icon: CaseSensitive, key: 'C' },
  { option: 'wholeWord', label: 'Match whole word', icon: WholeWord, key: 'W' },
  { option: 'regexp', label: 'Use regular expression', icon: Regex, key: 'R' }
]

const FIELD_BAND_CLASS = cn(
  'flex h-7 min-w-0 items-center gap-0.5 rounded-lg border border-field-border bg-background pl-2 transition-colors duration-150 ease-out',
  BAND_FOCUS_CLASS
)

/** On a popover, hover is the 6% wash (docs/design/colors.md). */
const BUTTON_CLASS = cn(
  QUIET_ICON_BUTTON_CLASS,
  'size-6 shrink-0 hover:bg-foreground/[0.06] disabled:pointer-events-none disabled:text-disabled-foreground'
)

/** Count-slot text. Empty while there is no query, so the slot keeps its width without noise. */
function statusLabel(status: FindStatus): string {
  if (status.kind === 'empty') return ''
  if (status.kind === 'invalid') return 'Invalid regex'
  if (status.total === 0) return 'No results'
  const total = `${status.total}${status.capped ? '+' : ''}`
  return `${status.current > 0 ? status.current : '?'} of ${total}`
}

/** Buttons keep focus in the field, so typing carries on after a click. */
function keepFieldFocus(event: MouseEvent): void {
  event.preventDefault()
}

/** Local copy of a field value, reset whenever the owner's value changes underneath it. */
function useFieldValue(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value)
  const [source, setSource] = useState(value)
  if (value !== source) {
    setSource(value)
    setDraft(value)
  }
  return [draft, setDraft]
}

/** Quiet 24px icon button whose tooltip names the action and its shortcut. */
function WidgetButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  disabled,
  expanded,
  iconClassName
}: {
  icon: TermulIcon
  label: string
  shortcut?: string
  onClick: () => void
  disabled?: boolean
  expanded?: boolean
  iconClassName?: string
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          disabled={disabled}
          onMouseDown={keepFieldFocus}
          onClick={onClick}
          className={BUTTON_CLASS}
        >
          <Icon size={14} className={iconClassName} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-2.5 py-1.5 text-xs">
        <span className="text-popover-foreground">{withShortcut(label, shortcut)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * On/off search option inside the find field. Pressed is the foreground wash,
 * not a keycap, because it sits on a popover (docs/design/colors.md).
 */
function OptionToggle({
  icon: Icon,
  label,
  shortcut,
  pressed,
  onToggle
}: {
  icon: TermulIcon
  label: string
  shortcut: string
  pressed: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onMouseDown={keepFieldFocus}
          onClick={onToggle}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-md transition-colors duration-150 ease-out',
            FOCUS_RING_CLASS,
            pressed
              ? 'bg-foreground/10 text-foreground'
              : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
          )}
        >
          <Icon size={14} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-2.5 py-1.5 text-xs">
        <span className="text-popover-foreground">{withShortcut(label, shortcut)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Floating find (and replace) box in the style of VS Code's find widget: one
 * field with Aa / ab / .* toggles, a match count, previous / next / close, and
 * an optional replace row. Presentational: the owner holds the query and
 * moves the selection.
 */
export function FindWidget({
  search,
  onSearchChange,
  options,
  onOptionsChange,
  status,
  onNext,
  onPrevious,
  onClose,
  replace,
  onKeyDown,
  className
}: FindWidgetProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const searchRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  const [searchDraft, setSearchDraft] = useFieldValue(search)
  const [replaceDraft, setReplaceDraft] = useFieldValue(replace?.value ?? '')
  const hasMatches = status.kind === 'matches' && status.total > 0
  const label = statusLabel(status)

  /** The owner's keys first (CodeMirror's search-panel keymap), then VS Code's widget keys. */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A key that confirms an IME composition is not a command. Safari fires
    // compositionend before that keydown, so only the legacy keyCode 229 marks it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (onKeyDown?.(event.nativeEvent)) {
      event.preventDefault()
      return
    }
    const { altKey, ctrlKey, metaKey, shiftKey } = event
    // event.code, not event.key: Option+C types "ç" on macOS.
    const toggle =
      altKey && !ctrlKey && !metaKey && !shiftKey
        ? OPTION_TOGGLES.find(({ key }) => event.code === `Key${key}`)
        : undefined
    if (toggle) {
      event.preventDefault()
      onOptionsChange({ ...options, [toggle.option]: !options[toggle.option] })
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Enter') return
    if (replace && altKey && (isMac ? metaKey : ctrlKey)) {
      event.preventDefault()
      replace.onReplaceAll()
    } else if (replace && event.target === replaceRef.current) {
      event.preventDefault()
      replace.onReplace()
    } else if (event.target === searchRef.current) {
      event.preventDefault()
      if (shiftKey) onPrevious()
      else onNext()
    }
  }

  return (
    <motion.div
      role="search"
      aria-label="Find"
      data-find-widget=""
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex w-[26rem] max-w-[calc(100%-2.5rem)] items-start gap-0.5 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md',
        className
      )}
    >
      {replace && (
        <WidgetButton
          icon={ChevronRight}
          label="Toggle replace"
          shortcut={isMac ? findShortcut('mod', 'alt', 'F') : findShortcut('mod', 'H')}
          expanded={replace.open}
          onClick={() => replace.onOpenChange(!replace.open)}
          iconClassName={cn(
            'transition-transform duration-150 ease-out',
            replace.open && 'rotate-90'
          )}
        />
      )}
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-0.5 gap-y-1">
        <div className={cn(FIELD_BAND_CLASS, 'pr-0.5')}>
          <input
            ref={searchRef}
            type="text"
            value={searchDraft}
            onChange={(event) => {
              setSearchDraft(event.target.value)
              onSearchChange(event.target.value)
            }}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            autoComplete="off"
            // CodeMirror focuses the [main-field] input when find is reopened.
            main-field="true"
            data-find-field="search"
            className={cn(
              'h-full min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground pointer-coarse:text-base',
              INNER_FIELD_FOCUS_CLASS
            )}
          />
          {OPTION_TOGGLES.map(({ option, label: toggleLabel, icon, key }) => (
            <OptionToggle
              key={option}
              icon={icon}
              label={toggleLabel}
              shortcut={findShortcut('alt', key)}
              pressed={options[option]}
              onToggle={() => onOptionsChange({ ...options, [option]: !options[option] })}
            />
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          <span
            aria-live="polite"
            className={cn(
              'min-w-16 shrink-0 whitespace-nowrap px-1 text-center text-2xs tabular-nums',
              status.kind === 'invalid' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {label}
          </span>
          <WidgetButton
            icon={ArrowUp}
            label="Previous match"
            shortcut={findShortcut('shift', 'Enter')}
            disabled={!hasMatches}
            onClick={onPrevious}
          />
          <WidgetButton
            icon={ArrowDown}
            label="Next match"
            shortcut="Enter"
            disabled={!hasMatches}
            onClick={onNext}
          />
          <WidgetButton icon={X} label="Close" shortcut="Escape" onClick={onClose} />
        </div>
        {replace?.open && (
          <>
            <div className={cn(FIELD_BAND_CLASS, 'pr-2')}>
              <input
                ref={replaceRef}
                type="text"
                value={replaceDraft}
                onChange={(event) => {
                  setReplaceDraft(event.target.value)
                  replace.onValueChange(event.target.value)
                }}
                placeholder="Replace"
                aria-label="Replace"
                spellCheck={false}
                autoComplete="off"
                data-find-field="replace"
                className={cn(
                  'h-full min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground pointer-coarse:text-base',
                  INNER_FIELD_FOCUS_CLASS
                )}
              />
            </div>
            <div className="flex items-center gap-0.5">
              <WidgetButton
                icon={Replace}
                label="Replace"
                shortcut="Enter"
                disabled={!hasMatches}
                onClick={replace.onReplace}
              />
              <WidgetButton
                icon={ReplaceAll}
                label="Replace all"
                shortcut={findShortcut('mod', 'alt', 'Enter')}
                disabled={!hasMatches}
                onClick={replace.onReplaceAll}
              />
            </div>
          </>
        )}
      </div>
    </motion.div>
  )
}
