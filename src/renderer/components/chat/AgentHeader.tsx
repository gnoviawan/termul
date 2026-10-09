import { type ReactNode, useState } from 'react'
import { Bot, Brain, Check } from '@/components/icons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import {
  MENU_LABEL_CLASS,
  menuOptionRowClass,
  pickerSearchTextClass
} from '@/components/ui/menu-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { ComposerPill } from './ComposerPill'
import { flattenConfigOptionValues } from './chat-input-bar-config'
import { KNOWN_CATEGORY_HEADINGS } from './slash-menu-model'
import { useOptimisticSelect } from './use-optimistic-select'
import { keepFocusOnMousePress, useTapSelect } from './use-tap-select'

export function SelectorOptionLabel({
  name,
  description,
  selected
}: {
  name: string
  description?: string | null
  selected: boolean
}): React.JSX.Element {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{name}</span>
        {description && <span className="text-2xs text-muted-foreground">{description}</span>}
      </span>
      <SelectedCheck selected={selected} />
    </>
  )
}

/**
 * Trailing selection mark on a picker option row. Always rendered, hidden when
 * not selected, so rows keep one width. Selection has no fill: see
 * docs/design/overlays.md (Menus).
 */
export function SelectedCheck({ selected }: { selected: boolean }): React.JSX.Element {
  return (
    <Check
      size={14}
      aria-hidden="true"
      className={cn('mt-0.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
    />
  )
}

/**
 * Resolve the display label for a config chip. Promoted chips (e.g.
 * `thought_level`) use the shared category heading; generic chips keep their
 * original `option.name` fallback unchanged.
 */
function getLabelForConfigChip(option: SessionConfigOption, promoted: boolean): string {
  if (!promoted || !option.category) return option.name
  return KNOWN_CATEGORY_HEADINGS[option.category] ?? option.name
}

/**
 * Centered modal shell for a selector's option list on mobile web. Mirrors the
 * `CommandPalette` centered-overlay feel: `w-[calc(100%-2rem)]` leaves a 1rem
 * horizontal margin so the panel never bleeds edge-to-edge, `max-w-md` caps the
 * panel larger than the desktop `w-56` popover, and `max-h-[80vh]` keeps it on
 * screen when the OSK is open. A Radix `DialogTitle` + visually-hidden
 * `DialogDescription` (a11y-required by Dialog) carry the section label. The
 * `disabled` prop forwards to `DialogTrigger` so the mobile trigger gates
 * opening identically to the desktop `PopoverTrigger`. The search input +
 * option rows are passed as children (the children own their own scroll
 * container); only the outer shell differs from the desktop `Popover`.
 */
export function SelectorModal({
  open,
  onOpenChange,
  title,
  trigger,
  disabled,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  trigger: ReactNode
  disabled: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild disabled={disabled}>
        {trigger}
      </DialogTrigger>
      <DialogContent className="mx-auto max-h-[80vh] w-[calc(100%-2rem)] max-w-md gap-0 overflow-y-auto rounded-2xl p-0">
        <DialogHeader className={cn(MENU_LABEL_CLASS, 'px-3 pb-1 pt-3 pr-9')}>
          <DialogTitle className="text-muted-foreground">{title}</DialogTitle>
          <DialogDescription className="sr-only">{title} options</DialogDescription>
        </DialogHeader>
        <div className="px-1 pb-2">{children}</div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A selector for one config option. When `promoted` is set (e.g. a
 * `thought_level` reasoning-level option, issue #286), the chip gains a leading
 * icon and uses the shared category heading for its popover title, giving it
 * visual priority over generic `other` options.
 *
 * While `onSelect` is in flight, the chip shows an optimistic label and swaps
 * the trailing chevron for a spinner. Soft-replace: selecting again on the same
 * chip takes the latest value; stale RPC completions are ignored.
 *
 * On mobile web (viewport ≤ 767px, non-Tauri) the option list opens in a
 * centered `Dialog` modal (see `SelectorModal`) instead of the desktop
 * `Popover` — the cramped 224px popover clips and collides with the OSK on a
 * narrow phone pane. Desktop keeps the `Popover` byte-identical (non-regression).
 */
export function ConfigChip({
  option,
  disabled,
  onSelect,
  promoted = false,
  searchable = false,
  maxVisibleOptions,
  leading
}: {
  option: SessionConfigOption
  disabled: boolean
  onSelect: (valueId: string) => void | Promise<void>
  promoted?: boolean
  searchable?: boolean
  maxVisibleOptions?: number
  /** Optional leading glyph (e.g. agent icon on the model pill). */
  leading?: ReactNode
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const isMobile = useMobileWebShell()
  const tapSelect = useTapSelect()
  const committed = typeof option.currentValue === 'string' ? option.currentValue : undefined
  const { displayValue, pending, select } = useOptimisticSelect(committed, onSelect)
  const values = flattenConfigOptionValues(option)
  const current = values.find((item) => item.value === displayValue)
  const fallbackLabel = getLabelForConfigChip(option, promoted)
  const showSearch = searchable && values.length > (maxVisibleOptions ?? 0)
  // A boolean option, or a select with no values, has no menu. Callers render
  // booleans as toggles. Returning nothing here avoids an empty picker.
  if (values.length === 0) return null
  const normalizedQuery = query.trim().toLowerCase()
  const filteredOptions = values.filter((value) => {
    if (!normalizedQuery) return true
    return [value.name, value.value, value.description ?? '', value.group ?? '']
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery)
  })

  const handleSelect = (valueId: string): void => {
    setQuery('')
    setOpen(false)
    select(valueId)
  }

  const trigger = (
    <ComposerPill disabled={disabled} chevron pending={pending}>
      {leading}
      {promoted && <Brain size={13} className="shrink-0 text-muted-foreground" />}
      {current?.name ?? fallbackLabel}
    </ComposerPill>
  )

  const optionsList = (
    <>
      {showSearch && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models…"
          aria-label="Search models"
          className={cn(
            'mb-1 h-8 w-full border-b border-border bg-transparent px-2 text-foreground outline-none placeholder:text-muted-foreground',
            pickerSearchTextClass(isMobile)
          )}
        />
      )}
      <div
        data-testid={searchable ? 'config-chip-model-options' : 'config-chip-options'}
        className="max-h-[180px] overflow-y-auto pr-1"
      >
        {filteredOptions.length > 0 ? (
          filteredOptions.map((v, index) => (
            <div key={v.value}>
              {v.group && filteredOptions[index - 1]?.group !== v.group ? (
                <div className={MENU_LABEL_CLASS}>{v.group}</div>
              ) : null}
              <button
                type="button"
                {...tapSelect(() => handleSelect(v.value))}
                onPointerDown={keepFocusOnMousePress}
                data-press-feedback="off"
                aria-pressed={v.value === displayValue}
                className={menuOptionRowClass(isMobile)}
              >
                <SelectorOptionLabel
                  name={v.name}
                  description={v.description}
                  selected={v.value === displayValue}
                />
              </button>
            </div>
          ))
        ) : (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No models match. Try another name.
          </div>
        )}
      </div>
    </>
  )

  if (isMobile) {
    return (
      <SelectorModal
        open={open}
        onOpenChange={setOpen}
        title={promoted ? fallbackLabel : option.name}
        trigger={trigger}
        disabled={disabled}
      >
        {optionsList}
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        className={cn('rounded-xl p-1', searchable ? 'w-56' : 'w-40')}
      >
        <div className={MENU_LABEL_CLASS}>{promoted ? fallbackLabel : option.name}</div>
        {optionsList}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Selector for the native ACP `session.modes` API (`session/set_mode`).
 * Prefer this over a duplicate `category: 'mode'` ConfigChip when both exist.
 *
 * On mobile web the option list opens in a centered `Dialog` modal (see
 * `SelectorModal`); desktop keeps the `Popover` (non-regression).
 */
export function ModeChip({
  session,
  disabled,
  onSelect,
  label = 'Mode'
}: {
  session: AcpSession
  disabled: boolean
  onSelect: (modeId: string) => void | Promise<void>
  label?: string
}): React.JSX.Element | null {
  const modes = session.modes
  const [open, setOpen] = useState(false)
  const isMobile = useMobileWebShell()
  const tapSelect = useTapSelect()
  const { displayValue, pending, select } = useOptimisticSelect(modes?.currentModeId, onSelect)

  if (!modes || modes.availableModes.length === 0) return null

  const current = modes.availableModes.find((m) => m.id === displayValue)

  const handleSelect = (modeId: string): void => {
    setOpen(false)
    select(modeId)
  }

  const trigger = (
    <ComposerPill disabled={disabled} chevron pending={pending}>
      <Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      {current?.name ?? label}
    </ComposerPill>
  )

  const optionsList = (
    <div
      data-testid="mode-chip-options"
      className="max-h-[180px] overflow-y-auto overscroll-contain pr-1"
    >
      {modes.availableModes.map((m) => (
        <button
          key={m.id}
          type="button"
          {...tapSelect(() => handleSelect(m.id))}
          onPointerDown={keepFocusOnMousePress}
          data-press-feedback="off"
          aria-pressed={m.id === displayValue}
          className={menuOptionRowClass(isMobile)}
        >
          <SelectorOptionLabel
            name={m.name}
            description={m.description}
            selected={m.id === displayValue}
          />
        </button>
      ))}
    </div>
  )

  if (isMobile) {
    return (
      <SelectorModal
        open={open}
        onOpenChange={setOpen}
        title={label}
        trigger={trigger}
        disabled={disabled}
      >
        {optionsList}
      </SelectorModal>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        className="w-40 rounded-xl p-1"
      >
        <div className={MENU_LABEL_CLASS}>{label}</div>
        {optionsList}
      </PopoverContent>
    </Popover>
  )
}
