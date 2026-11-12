import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MENU_CONTENT_CLASS } from '@/components/ui/menu-styles'
import { FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverSearchBand } from '@/components/ui/popover-search-band'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { SAVING_MESSAGE } from '../draft/use-draft'
import {
  fillHole,
  matchSuggestions,
  openHole,
  type TemplateSuggestion,
  templateError
} from './template-scope'

/**
 * Turns a field's text into a draft edit, or says why it cannot (and keeps
 * the text). Returning null means the edit was taken.
 */
export type Commit = (text: string) => string | null

const FIELD_HEIGHT = 'h-9 pointer-coarse:h-11'

export function Field({
  id,
  label,
  error,
  help,
  labelHidden = false,
  required = false,
  children
}: {
  id: string
  label: string
  error?: string | null
  help?: string
  labelHidden?: boolean
  /** Marks a value the host requires. */
  required?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const labelElement = (
    <Label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-xs'}>
      {label}
    </Label>
  )
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {required ? (
        <div className="flex items-baseline justify-between gap-2">
          {labelElement}
          <span className="text-xs text-muted-foreground">Required</span>
        </div>
      ) : (
        labelElement
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  )
}

export function describedBy(id: string, error: string | null | undefined, help?: string) {
  if (error) return { 'aria-invalid': true, 'aria-describedby': `${id}-error` } as const
  return help ? ({ 'aria-describedby': `${id}-help` } as const) : {}
}

/**
 * A field's text while it is edited. The draft hears of it once, on Enter or
 * blur, so one edit is one undo step; Escape puts the saved value back. When
 * the saved value changes (undo, redo, another edit), the text follows it.
 */
export function useFieldText(value: string, commit: Commit) {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(value)
    setError(null)
  }
  const save = (): void => {
    if (text === value) {
      setError(null)
      return
    }
    const refused = commit(text)
    setError(refused)
    // A refused edit keeps the text to fix; a taken one shows the value as stored.
    if (refused === null) setText(value)
  }
  return {
    text,
    setText,
    error,
    /** Shows `message` under the field and keeps the text. */
    fail: setError,
    save,
    /**
     * Enter saves (unless `enterSaves` says otherwise); Escape reverts an
     * unsaved edit and keeps the key, so it does not also close the sheet.
     */
    onKeyDown: (event: React.KeyboardEvent, enterSaves = true): void => {
      if (event.key === 'Enter' && enterSaves) {
        event.preventDefault()
        save()
      } else if (event.key === 'Escape' && (text !== value || error !== null)) {
        event.preventDefault()
        setText(value)
        setError(null)
      }
    }
  }
}

export function TextField({
  id,
  label,
  value,
  commit,
  error,
  help,
  placeholder,
  mono = false,
  type,
  suffix,
  onText
}: {
  id: string
  label: string
  value: string
  commit: Commit
  error?: string | null
  help?: string
  placeholder?: string
  mono?: boolean
  type?: 'datetime-local'
  /** A unit drawn inside the field's end, such as `seconds`. */
  suffix?: string
  /** Hears the text as it is typed, before it is saved. */
  onText?: (text: string) => void
}): React.JSX.Element {
  const field = useFieldText(value, commit)
  const shown = field.error ?? error
  useEffect(() => onText?.(field.text), [onText, field.text])
  const input = (
    <Input
      id={id}
      type={type}
      value={field.text}
      placeholder={placeholder}
      className={cn(FIELD_HEIGHT, mono && 'font-mono', suffix && 'pr-20 tabular-nums')}
      {...describedBy(id, shown, help)}
      onChange={(event) => field.setText(event.target.value)}
      onBlur={field.save}
      onKeyDown={(event) => field.onKeyDown(event)}
    />
  )
  return (
    <Field id={id} label={label} error={shown} help={help}>
      {suffix ? (
        <div className="relative">
          {input}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
          >
            {suffix}
          </span>
        </div>
      ) : (
        input
      )}
    </Field>
  )
}

/**
 * A `{{ … }}` template. Typing `{{` lists what this step may read (`scope`);
 * picking one writes the whole reference. The host's syntax errors show
 * under the field.
 */
export function TemplateField({
  id,
  label,
  value,
  commit,
  scope,
  error,
  help,
  placeholder,
  multiline = false,
  labelHidden = false,
  required = false
}: {
  id: string
  label: string
  value: string
  commit: Commit
  scope: readonly TemplateSuggestion[]
  error?: string | null
  help?: string
  placeholder?: string
  multiline?: boolean
  labelHidden?: boolean
  required?: boolean
}): React.JSX.Element {
  const field = useFieldText(value, commit)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const [hole, setHole] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const caretAfter = useRef<number | null>(null)
  const matches = hole ? matchSuggestions(scope, hole.query) : []
  const open = matches.length > 0
  const shown = field.error ?? templateError(field.text) ?? error
  const listId = `${id}-references`

  useLayoutEffect(() => {
    if (caretAfter.current === null || !ref.current) return
    ref.current.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  })

  const track = (element: HTMLInputElement | HTMLTextAreaElement): void => {
    const next = openHole(element.value, element.selectionStart ?? element.value.length)
    setHole((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next))
    setActive(0)
  }
  const pick = (suggestion: TemplateSuggestion): void => {
    if (!hole) return
    const caret = ref.current?.selectionStart ?? field.text.length
    const filled = fillHole(field.text, caret, hole.start, suggestion.path)
    field.setText(filled.text)
    caretAfter.current = filled.caret
    setHole(null)
  }

  const control = {
    id,
    ref,
    value: field.text,
    placeholder,
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? `${listId}-${active}` : undefined,
    ...describedBy(id, shown, help),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      field.setText(event.target.value)
      track(event.target)
    },
    onSelect: (event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      track(event.currentTarget),
    onBlur: () => {
      setHole(null)
      field.save()
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive((index) => (index + step + matches.length) % matches.length)
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          pick(matches[Math.min(active, matches.length - 1)])
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setHole(null)
        }
        return
      }
      field.onKeyDown(event, !multiline || event.metaKey || event.ctrlKey)
    }
  } as const

  return (
    <Field
      id={id}
      label={label}
      error={shown}
      help={help}
      labelHidden={labelHidden}
      required={required}
    >
      <Popover open={open} onOpenChange={(next) => !next && setHole(null)}>
        <PopoverAnchor asChild>
          <div ref={anchor}>
            {multiline ? (
              <Textarea {...control} rows={3} className="min-h-[72px] resize-y" />
            ) : (
              <Input {...control} className={cn(FIELD_HEIGHT, 'font-mono')} />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className={cn(MENU_CONTENT_CLASS, 'w-[var(--radix-popover-trigger-width)] p-1')}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (anchor.current?.contains(event.target as Node)) event.preventDefault()
          }}
        >
          <div
            id={listId}
            role="listbox"
            aria-label="References"
            className="max-h-64 overflow-y-auto"
          >
            {matches.map((suggestion, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field keeps focus and picks with arrows and Enter (aria-activedescendant)
              <div
                key={suggestion.path}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                className={cn(
                  'flex min-h-8 cursor-default flex-col rounded-lg px-2 py-1.5',
                  index === active && 'bg-foreground/[0.06]'
                )}
                // Keep focus in the field, so picking is not a blur that saves.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(suggestion)}
              >
                <span className="truncate text-xs text-foreground">
                  {suggestion.label}
                  <span className="text-muted-foreground"> · {suggestion.detail}</span>
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {suggestion.path}
                </span>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  )
}

/** A whole number the host stores unsigned (`u32`). */
const U32_MAX = 4_294_967_295

export function NumberField({
  id,
  label,
  value,
  commit,
  error,
  help
}: {
  id: string
  label: string
  value: number
  commit: (value: number) => boolean
  error?: string | null
  help?: string
}): React.JSX.Element {
  return (
    <TextField
      id={id}
      label={label}
      value={String(value)}
      error={error}
      help={help}
      commit={(text) => {
        const n = Number(text.trim())
        if (text.trim() === '' || !Number.isInteger(n) || n < 0 || n > U32_MAX) {
          return 'Enter a whole number'
        }
        return commit(n) ? null : SAVING_MESSAGE
      }}
    />
  )
}

const UNITS = [
  { value: 'days', label: 'days', ms: 86_400_000 },
  { value: 'hours', label: 'hours', ms: 3_600_000 },
  { value: 'minutes', label: 'minutes', ms: 60_000 },
  { value: 'seconds', label: 'seconds', ms: 1000 }
] as const
type Unit = (typeof UNITS)[number]['value']

/** The largest unit `ms` is a whole number of; seconds otherwise. */
function unitOf(ms: number): Unit {
  return (UNITS.find((unit) => ms > 0 && ms % unit.ms === 0) ?? UNITS[3]).value
}

const msOf = (unit: Unit) => UNITS.find((entry) => entry.value === unit)?.ms ?? 1000

/** `text` in `unit` as whole milliseconds, or why it is not a duration. */
function toMs(text: string, unit: Unit): number | string {
  const n = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(n) || n < 0) return 'Enter a number'
  const ms = Math.round(n * msOf(unit))
  return Number.isSafeInteger(ms) ? ms : 'That is too long'
}

/** A duration stored in milliseconds, edited as a number and a unit. */
export function DurationField({
  id,
  label,
  value,
  commit,
  error,
  help,
  onDraft
}: {
  id: string
  label: string
  value: number
  commit: (ms: number) => boolean
  error?: string | null
  help?: string
  /** Hears the duration as it is typed, before it is saved; null while it is no duration. */
  onDraft?: (ms: number | null) => void
}): React.JSX.Element {
  const [unit, setUnit] = useState<Unit>(() => unitOf(value))
  const [shownValue, setShownValue] = useState(value)
  if (shownValue !== value) {
    setShownValue(value)
    // The unit just picked stays while it still counts the value in whole numbers.
    if (value % msOf(unit) !== 0) setUnit(unitOf(value))
  }
  const field = useFieldText(String(value / msOf(unit)), (text) => {
    const ms = toMs(text, unit)
    if (typeof ms === 'string') return ms
    return commit(ms) ? null : SAVING_MESSAGE
  })
  const shown = field.error ?? error
  useEffect(() => {
    if (!onDraft) return
    const ms = toMs(field.text, unit)
    onDraft(typeof ms === 'number' ? ms : null)
  }, [onDraft, field.text, unit])
  return (
    <Field id={id} label={label} error={shown} help={help}>
      <div className="flex gap-2">
        <Input
          id={id}
          inputMode="decimal"
          value={field.text}
          className={cn(FIELD_HEIGHT, 'min-w-0 flex-1 tabular-nums')}
          {...describedBy(id, shown, help)}
          onChange={(event) => field.setText(event.target.value)}
          onBlur={field.save}
          onKeyDown={(event) => field.onKeyDown(event)}
        />
        <Select
          value={unit}
          onValueChange={(next) => {
            const ms = toMs(field.text, next as Unit)
            // A refused change keeps the unit and the typed number, and says why.
            if (typeof ms === 'string') field.fail(ms)
            else if (ms !== value && !commit(ms)) field.fail(SAVING_MESSAGE)
            else setUnit(next as Unit)
          }}
        >
          <SelectTrigger aria-label={`${label} unit`} className={cn(FIELD_HEIGHT, 'w-28')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNITS.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Field>
  )
}

export function ChoiceField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  help,
  error,
  placeholder,
  disabled = false,
  labelHidden = false,
  required = false
}: {
  id: string
  label: string
  /** `''` shows the placeholder. */
  value: T | ''
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  help?: string
  error?: string | null
  placeholder?: string
  disabled?: boolean
  labelHidden?: boolean
  required?: boolean
}): React.JSX.Element {
  return (
    <Field
      id={id}
      label={label}
      help={help}
      error={error}
      labelHidden={labelHidden}
      required={required}
    >
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => next !== value && onChange(next as T)}
      >
        <SelectTrigger id={id} className={FIELD_HEIGHT} {...describedBy(id, error, help)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** More options than this, and the picker gets a search band. */
const SEARCH_FROM = 8

/**
 * A pick-one field over a list that can run long (an MCP server's tools):
 * a select-like trigger opening a list with a description per option,
 * searchable when it is long.
 */
export function PickerField({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  error,
  help,
  disabled = false
}: {
  id: string
  label: string
  value: string
  options: readonly { value: string; detail?: string }[]
  onChange: (value: string) => void
  placeholder: string
  error?: string | null
  help?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? options.filter(
        (option) =>
          option.value.toLowerCase().includes(q) || option.detail?.toLowerCase().includes(q)
      )
    : options
  const pick = (next: string): void => {
    setOpen(false)
    setQuery('')
    if (next !== value) onChange(next)
  }
  return (
    <Field id={id} label={label} error={error} help={help}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            className={cn(
              FIELD_HEIGHT,
              'flex w-full items-center justify-between gap-2 rounded-lg border border-field-border bg-background px-3 text-left text-sm transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50',
              FIELD_FOCUS_CLASS
            )}
            {...describedBy(id, error, help)}
          >
            <span className={cn('truncate font-mono', !value && 'text-muted-foreground')}>
              {value || placeholder}
            </span>
            <ChevronDown size={16} className="shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(MENU_CONTENT_CLASS, 'w-[var(--radix-popover-trigger-width)] p-0')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) {
              event.preventDefault()
              pick(shown[0].value)
            }
          }}
        >
          {options.length > SEARCH_FROM && (
            <PopoverSearchBand
              autoFocus
              value={query}
              onChange={setQuery}
              placeholder={`Search ${label.toLowerCase()}s`}
              ariaLabel={`Search ${label.toLowerCase()}s`}
              inputClassName="text-sm"
            />
          )}
          <div role="listbox" aria-label={label} className="max-h-72 overflow-y-auto p-1">
            {shown.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">Nothing matches.</p>
            )}
            {shown.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onClick={() => pick(option.value)}
                className={cn(
                  'flex min-h-8 w-full flex-col items-start rounded-lg px-2 py-1.5 text-left outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]',
                  option.value === value && 'bg-foreground/[0.06]'
                )}
              >
                <span className="truncate font-mono text-xs text-foreground">{option.value}</span>
                {option.detail && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {option.detail}
                  </span>
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </Field>
  )
}

/** A duration stored in milliseconds, typed in seconds. */
export function SecondsField({
  id,
  label,
  value,
  commit,
  error
}: {
  id: string
  label: string
  value: number
  commit: (ms: number) => boolean
  error?: string | null
}): React.JSX.Element {
  return (
    <TextField
      id={id}
      label={label}
      value={String(value / 1000)}
      suffix="seconds"
      error={error}
      commit={(text) => {
        const n = Number(text.trim())
        if (text.trim() === '' || !Number.isFinite(n) || n < 0) return 'Enter a number of seconds'
        const ms = Math.round(n * 1000)
        if (!Number.isSafeInteger(ms)) return 'That is too long'
        return commit(ms) ? null : SAVING_MESSAGE
      }}
    />
  )
}
