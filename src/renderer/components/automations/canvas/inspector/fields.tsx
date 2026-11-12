import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MENU_CONTENT_CLASS } from '@/components/ui/menu-styles'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
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
  children
}: {
  id: string
  label: string
  error?: string | null
  help?: string
  labelHidden?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className={labelHidden ? 'sr-only' : 'text-xs'}>
        {label}
      </Label>
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
  return {
    text,
    setText,
    error,
    save: () => {
      if (text === value) return setError(null)
      const refused = commit(text)
      setError(refused)
      // A refused edit keeps the text to fix; a taken one shows the value as stored.
      if (refused === null) setText(value)
    },
    revert: () => {
      setText(value)
      setError(null)
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
  /** Hears the text as it is typed, before it is saved. */
  onText?: (text: string) => void
}): React.JSX.Element {
  const field = useFieldText(value, commit)
  const shown = field.error ?? error
  useEffect(() => onText?.(field.text), [onText, field.text])
  return (
    <Field id={id} label={label} error={shown} help={help}>
      <Input
        id={id}
        type={type}
        value={field.text}
        placeholder={placeholder}
        className={cn(FIELD_HEIGHT, mono && 'font-mono')}
        {...describedBy(id, shown, help)}
        onChange={(event) => field.setText(event.target.value)}
        onBlur={field.save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') field.save()
          else if (event.key === 'Escape') field.revert()
        }}
      />
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
  labelHidden = false
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
}): React.JSX.Element {
  const field = useFieldText(value, commit)
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const [hole, setHole] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const caretAfter = useRef<number | null>(null)
  const matches = hole ? matchSuggestions(scope, hole.query) : []
  const open = matches.length > 0
  const shown = field.error ?? templateError(value) ?? error
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
      if (event.key === 'Escape') field.revert()
      else if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        field.save()
      }
    }
  } as const

  return (
    <Field id={id} label={label} error={shown} help={help} labelHidden={labelHidden}>
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

/** A duration stored in milliseconds, edited as a number and a unit. */
export function DurationField({
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
  commit: (ms: number) => boolean
  error?: string | null
  help?: string
}): React.JSX.Element {
  const [unit, setUnit] = useState<Unit>(() => unitOf(value))
  const [shownValue, setShownValue] = useState(value)
  if (shownValue !== value) {
    setShownValue(value)
    // The unit just picked stays while it still counts the value in whole numbers.
    if (value % msOf(unit) !== 0) setUnit(unitOf(value))
  }
  const toMs = (text: string, inUnit: Unit): number | null => {
    const n = Number(text.trim())
    if (text.trim() === '' || !Number.isFinite(n) || n < 0) return null
    return Math.round(n * msOf(inUnit))
  }
  const field = useFieldText(String(value / msOf(unit)), (text) => {
    const ms = toMs(text, unit)
    if (ms === null) return 'Enter a number'
    return commit(ms) ? null : SAVING_MESSAGE
  })
  const shown = field.error ?? error
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
          onKeyDown={(event) => {
            if (event.key === 'Enter') field.save()
            else if (event.key === 'Escape') field.revert()
          }}
        />
        <Select
          value={unit}
          onValueChange={(next) => {
            setUnit(next as Unit)
            const ms = toMs(field.text, next as Unit)
            if (ms !== null && ms !== value) commit(ms)
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
  help
}: {
  id: string
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  help?: string
}): React.JSX.Element {
  return (
    <Field id={id} label={label} help={help}>
      <Select value={value} onValueChange={(next) => next !== value && onChange(next as T)}>
        <SelectTrigger id={id} className={FIELD_HEIGHT} {...describedBy(id, null, help)}>
          <SelectValue />
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
