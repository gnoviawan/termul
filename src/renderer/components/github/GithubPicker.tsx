import type { GithubRepoLabel } from '@shared/types/github.types'
import { type ReactElement, type ReactNode, useCallback, useId, useMemo, useState } from 'react'
import { Check, Plus } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import {
  MobileSheetContent,
  SheetGroup,
  SheetRow,
  SheetSearchField,
  useSheetStack
} from '@/components/ui/mobile-sheet'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { WriteGate } from '@/components/ui/write-gate'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { LabelChip } from './github-status'
import { labelColors, useSurfaceHex } from './label-color'

export interface GithubPickerOption {
  value: string
  label: string
  description?: string | null
  /** Drawn before the label: a label dot, an assignee's initials. */
  leading?: ReactNode
}

/** GitHub's default label colours, offered when creating a label; the first is preselected. */
export const LABEL_SWATCHES = [
  'b60205',
  'd93f0b',
  'fbca04',
  '0e8a16',
  '006b75',
  '1d76db',
  '0052cc',
  '5319e7'
] as const

/** GitHub's limits, which the host enforces too. */
const LABEL_NAME_MAX = 50
const LABEL_DESCRIPTION_MAX = 100

export interface GithubPickerCreate {
  /** Create the label on GitHub; resolves to its name, or null when GitHub refused. */
  onCreate: (
    label: Pick<GithubRepoLabel, 'name' | 'color' | 'description'>
  ) => Promise<string | null>
}

interface GithubPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The button that opens the picker; on desktop it also anchors the popover. */
  trigger: ReactElement
  title: string
  /** One line beside the title: what Done does. */
  hint?: string
  searchLabel: string
  options: readonly GithubPickerOption[]
  /** The options are still loading, or failed to load. */
  status: 'ready' | 'loading' | 'error'
  error?: string | null
  /** Selected when the picker opens. */
  initial: readonly string[]
  /** Controls between the search field and the list (the label filter's match mode). */
  toolbar?: ReactNode
  /** The apply button's text for the current selection. */
  applyLabel: (selected: readonly string[]) => string
  /** Apply the selection; resolve `true` to close the picker. */
  onApply: (selected: string[]) => Promise<boolean> | boolean
  /** Offer "Clear" in the header (filters only). */
  clearable?: boolean
  /** Draw a selected value in the phone's "Selected" strip. */
  renderSelected?: (value: string, remove: () => void) => ReactNode
  /** Offer a "Create label" row for a search with no exact match. */
  create?: GithubPickerCreate
  /** A write picker on a read-only server: apply and create are gated. */
  gated?: boolean
}

/**
 * Multi-select with search, used by the label filter, the label editor and
 * the assignee editor. A bottom sheet on the phone shell, a popover on
 * desktop. The selection is a draft until the apply button: closing the
 * picker any other way discards it.
 */
export function GithubPicker(props: GithubPickerProps): React.JSX.Element {
  const { open, onOpenChange, trigger } = props
  const isMobile = useMobileWebShell()
  // The draft lives here, not in the body: the phone sheet remounts its body on every push and pop.
  const [selected, setSelected] = useState<string[]>(() => [...props.initial])
  const [query, setQuery] = useState('')
  const overlayId = `github-picker:${useId()}`
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  useOverlayRegistration(overlayId, open && isMobile, close, { mobileShellOnly: true })
  const nav = useSheetStack<string>(overlayId, open && isMobile, (name) => `create:${name}`)
  const [desktopCreate, setDesktopCreate] = useState<string | null>(null)

  // Every open starts from what GitHub reports, however it opened (trigger,
  // ⋯ menu): a cancelled draft never comes back.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) {
      setSelected([...props.initial])
      setQuery('')
      setDesktopCreate(null)
    }
  }

  if (isMobile) {
    const creating = nav.top
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <MobileSheetContent
          title={creating === null ? props.title : 'New label'}
          nav={nav}
          aria-describedby={undefined}
          onEscapeKeyDown={nav.onEscapeKeyDown}
        >
          <PickerBody
            draft={{ selected, setSelected, query, setQuery }}
            {...props}
            touch
            creating={creating}
            onCreating={(name) => (name === null ? nav.pop() : nav.push(name))}
          />
        </MobileSheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="flex max-h-[var(--radix-popper-available-height,70vh)] w-80 flex-col overflow-hidden rounded-xl p-0"
      >
        <PickerBody
          draft={{ selected, setSelected, query, setQuery }}
          {...props}
          touch={false}
          creating={desktopCreate}
          onCreating={setDesktopCreate}
        />
      </PopoverContent>
    </Popover>
  )
}

interface PickerDraft {
  selected: string[]
  setSelected: React.Dispatch<React.SetStateAction<string[]>>
  query: string
  setQuery: (query: string) => void
}

interface PickerBodyProps extends GithubPickerProps {
  draft: PickerDraft
  touch: boolean
  /** The name of the label being created, or null on the list. */
  creating: string | null
  onCreating: (name: string | null) => void
}

function PickerBody(props: PickerBodyProps): React.JSX.Element {
  const { initial, options, creating, onCreating, create } = props
  const { selected, setSelected, query, setQuery } = props.draft
  const [applying, setApplying] = useState(false)

  // Selected-at-open first, then the rest in GitHub's order; values GitHub no
  // longer lists stay pickable so they can be removed.
  const ordered = useMemo(() => {
    const known = new Set(options.map((o) => o.value))
    const missing = initial
      .filter((value) => !known.has(value))
      .map((value): GithubPickerOption => ({ value, label: value }))
    const all = [...missing, ...options]
    const first = new Set(initial)
    return [...all.filter((o) => first.has(o.value)), ...all.filter((o) => !first.has(o.value))]
  }, [options, initial])

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? ordered.filter(
        (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
      )
    : ordered
  const exact = ordered.some((o) => o.value.toLowerCase() === needle)
  const offerCreate = Boolean(create && needle && !exact && props.status === 'ready')

  const toggle = (value: string): void => {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    )
  }

  const apply = async (): Promise<void> => {
    setApplying(true)
    try {
      if (await props.onApply(selected)) props.onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  if (creating !== null && create) {
    return (
      <CreateLabelForm
        key={creating}
        touch={props.touch}
        initialName={creating}
        gated={props.gated ?? false}
        onCancel={() => onCreating(null)}
        onCreate={async (label) => {
          const name = await create.onCreate(label)
          if (name === null) return
          setSelected((prev) => (prev.includes(name) ? prev : [...prev, name]))
          setQuery('')
          onCreating(null)
        }}
      />
    )
  }

  const applyButton = (
    <WriteGate gated={props.gated ?? false}>
      <Button
        size={props.touch ? 'touch' : 'sm'}
        className={cn(props.touch ? 'w-full px-4' : 'px-3')}
        disabled={applying || props.gated || props.status !== 'ready'}
        onClick={() => void apply()}
      >
        {applying ? 'Saving…' : props.applyLabel(selected)}
      </Button>
    </WriteGate>
  )

  const clear = props.clearable ? (
    <button
      type="button"
      onClick={() => setSelected([])}
      disabled={selected.length === 0}
      className={cn(
        'rounded-md px-1.5 text-xs font-medium text-primary disabled:text-muted-foreground',
        FOCUS_RING_CLASS
      )}
    >
      Clear
    </button>
  ) : null

  if (props.touch) {
    return (
      <>
        {(props.hint || clear) && (
          <div className="flex min-w-0 items-center justify-between gap-2 px-1">
            <p className="min-w-0 truncate text-xs text-muted-foreground">{props.hint}</p>
            {clear}
          </div>
        )}
        <SheetSearchField
          value={query}
          onChange={setQuery}
          placeholder={props.searchLabel}
          label={props.searchLabel}
        />
        {props.toolbar}
        <PickerStatus status={props.status} error={props.error} />
        {props.status !== 'loading' && (
          <SheetGroup>
            {visible.map((option) => (
              <SheetRow
                key={option.value}
                title={option.label}
                subtitle={option.description ?? undefined}
                icon={option.leading}
                accessory="check"
                selected={selected.includes(option.value)}
                onSelect={() => toggle(option.value)}
              />
            ))}
            {offerCreate && (
              <SheetRow
                title={`Create label “${query.trim()}”`}
                subtitle="Pick a colour next"
                icon={<Plus size={18} aria-hidden="true" />}
                accessory="chevron"
                subview={`create:${query.trim()}`}
                disabled={props.gated}
                onSelect={() => onCreating(query.trim())}
              />
            )}
          </SheetGroup>
        )}
        {visible.length === 0 && !offerCreate && props.status === 'ready' && (
          <p className="px-1 py-4 text-center text-sm text-muted-foreground">No matches.</p>
        )}
        {props.renderSelected && selected.length > 0 && (
          <div className="flex flex-col gap-1.5 px-1">
            <p className="text-xs text-muted-foreground">Selected</p>
            <div className="flex flex-wrap gap-1.5">
              {selected.map((value) => (
                <span key={value} className="contents">
                  {props.renderSelected?.(value, () => toggle(value))}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="sticky bottom-0 -mx-3 mt-auto flex gap-2 bg-popover px-3 pt-2">
          <Button
            variant="outline"
            size="touch"
            className="flex-1 px-4"
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <span className="flex flex-1 [&>*]:w-full">{applyButton}</span>
        </div>
      </>
    )
  }

  return (
    <Command shouldFilter={false} className="min-h-0 rounded-xl">
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 pt-2.5">
        <p className="min-w-0 truncate text-xs font-medium text-foreground">{props.title}</p>
        {clear}
      </div>
      <CommandInput value={query} onValueChange={setQuery} placeholder={props.searchLabel} />
      {props.toolbar && <div className="px-2 pt-2">{props.toolbar}</div>}
      <PickerStatus status={props.status} error={props.error} className="px-3 py-2" />
      {props.status !== 'loading' && (
        <CommandList className="max-h-72">
          <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
            No matches.
          </CommandEmpty>
          <CommandGroup>
            {visible.map((option) => {
              const checked = selected.includes(option.value)
              return (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => toggle(option.value)}
                  aria-checked={checked}
                  className="min-h-8 gap-2 rounded-lg text-xs"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border',
                      checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border'
                    )}
                  >
                    {checked && <Check size={12} />}
                  </span>
                  {option.leading}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.description && (
                    <span className="min-w-0 max-w-[45%] truncate text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandGroup>
          {offerCreate && (
            <>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value={`create:${query.trim()}`}
                  disabled={props.gated}
                  onSelect={() => onCreating(query.trim())}
                  className="min-h-8 gap-2 rounded-lg text-xs"
                >
                  <Plus size={14} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 truncate">Create label “{query.trim()}”</span>
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-2">
        {props.hint && (
          <p className="mr-auto min-w-0 truncate text-2xs text-muted-foreground">{props.hint}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="px-3"
          onClick={() => props.onOpenChange(false)}
        >
          Cancel
        </Button>
        {applyButton}
      </div>
    </Command>
  )
}

function PickerStatus({
  status,
  error,
  className
}: {
  status: GithubPickerProps['status']
  error?: string | null
  className?: string
}): React.JSX.Element | null {
  if (status === 'loading') {
    return (
      <div role="status" aria-label="Loading" className={cn('flex flex-col gap-2', className)}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }
  if (status === 'error') {
    return (
      <p role="alert" className={cn('text-xs text-destructive', className)}>
        Couldn't load from GitHub{error ? `: ${error}` : '.'}
      </p>
    )
  }
  return null
}

function CreateLabelForm({
  touch,
  initialName,
  gated,
  onCancel,
  onCreate
}: {
  touch: boolean
  initialName: string
  gated: boolean
  onCancel: () => void
  onCreate: (label: Pick<GithubRepoLabel, 'name' | 'color' | 'description'>) => Promise<void>
}): React.JSX.Element {
  const id = useId()
  const [name, setName] = useState(initialName.slice(0, LABEL_NAME_MAX))
  const [color, setColor] = useState<string>(LABEL_SWATCHES[0])
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const surface = useSurfaceHex('--popover')
  const canCreate = !gated && !creating && name.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setCreating(true)
    try {
      await onCreate({ name: name.trim(), color, description: description.trim() || null })
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      className={cn('flex flex-col gap-3', !touch && 'p-3')}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {!touch && <p className="text-xs font-medium text-foreground">New label</p>}
      <label htmlFor={`${id}-name`} className="flex flex-col gap-1 text-xs text-muted-foreground">
        Name
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={LABEL_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className={touch ? 'h-11' : 'h-8 text-xs'}
        />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="pb-1 text-xs text-muted-foreground">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {LABEL_SWATCHES.map((swatch) => {
            const ink = labelColors(swatch, surface)?.ink
            return (
              <button
                key={swatch}
                type="button"
                aria-label={`Colour #${swatch}`}
                aria-pressed={color === swatch}
                onClick={() => setColor(swatch)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-full border border-border',
                  color === swatch && 'ring-2 ring-foreground ring-offset-2 ring-offset-popover',
                  FOCUS_RING_CLASS
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-5 rounded-full bg-muted-foreground"
                  style={ink ? { backgroundColor: ink } : undefined}
                />
              </button>
            )
          })}
        </div>
      </fieldset>
      <label htmlFor={`${id}-desc`} className="flex flex-col gap-1 text-xs text-muted-foreground">
        Description (optional)
        <Input
          id={`${id}-desc`}
          value={description}
          maxLength={LABEL_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
          className={touch ? 'h-11' : 'h-8 text-xs'}
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Preview</span>
        <LabelChip label={{ name: name.trim() || 'label', color }} size="md" surface="--popover" />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant={touch ? 'outline' : 'ghost'}
          size={touch ? 'touch' : 'sm'}
          className={cn('px-3', touch && 'flex-1')}
          onClick={onCancel}
          disabled={creating}
        >
          Back
        </Button>
        <WriteGate gated={gated} className={touch ? 'flex-1 [&>*]:w-full' : undefined}>
          <Button
            type="submit"
            size={touch ? 'touch' : 'sm'}
            className="px-3"
            disabled={!canCreate}
          >
            {creating ? 'Creating…' : 'Create label'}
          </Button>
        </WriteGate>
      </div>
    </form>
  )
}
