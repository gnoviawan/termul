import { Bot, Brain } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { ComposerPill } from './ComposerPill'
import { KNOWN_CATEGORY_HEADINGS } from './slash-menu-model'
import { useOptimisticSelect } from './use-optimistic-select'

/**
 * Shared option-row chrome for composer config/mode popovers. On accent
 * hover/selected, the row switches to `text-accent-foreground` so secondary
 * copy (opacity-based) stays readable instead of washing out as muted-on-blue.
 */
const SELECTOR_OPTION_ROW =
  'flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
const SELECTOR_OPTION_SELECTED = 'bg-accent text-accent-foreground'
const SELECTOR_OPTION_DESCRIPTION = 'text-xs opacity-70'
const SELECTOR_SECTION_LABEL = 'label-group px-2 py-1 text-muted-foreground'

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
 * A popover selector for one config option. When `promoted` is set (e.g. a
 * `thought_level` reasoning-level option, issue #286), the chip gains a leading
 * icon and uses the shared category heading for its popover title, giving it
 * visual priority over generic `other` options.
 *
 * While `onSelect` is in flight, the chip shows an optimistic label and swaps
 * the trailing chevron for a spinner. Soft-replace: selecting again on the same
 * chip takes the latest value; stale RPC completions are ignored.
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
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const { displayValue, pending, select } = useOptimisticSelect(option.currentValue, onSelect)
  const current = option.options.find((o) => o.value === displayValue)
  const fallbackLabel = getLabelForConfigChip(option, promoted)
  const showSearch = searchable && option.options.length > (maxVisibleOptions ?? 0)
  const normalizedQuery = query.trim().toLowerCase()
  const filteredOptions = option.options.filter((value) => {
    if (!normalizedQuery) return true
    return [value.name, value.value, value.description ?? '']
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery)
  })

  const handleSelect = (valueId: string): void => {
    setQuery('')
    setOpen(false)
    select(valueId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill disabled={disabled} chevron pending={pending}>
          {leading}
          {promoted && <Brain size={13} className="shrink-0 text-muted-foreground" />}
          {current?.name ?? fallbackLabel}
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className={SELECTOR_SECTION_LABEL}>{promoted ? fallbackLabel : option.name}</div>
        {showSearch && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models..."
            aria-label="Search models"
            className="mb-1 w-full rounded-md bg-background px-2 py-1.5 text-base text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/40"
          />
        )}
        <div
          data-testid={searchable ? 'config-chip-model-options' : undefined}
          className={cn(maxVisibleOptions && 'max-h-[180px] overflow-y-auto pr-1')}
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((v) => (
              <button
                key={v.value}
                type="button"
                onPointerDown={(event) => {
                  // Primary only; treat missing button as primary (jsdom/synthetic).
                  if ((event.button ?? 0) !== 0) return
                  // Prefer pointerdown so the choice lands before Radix closes the
                  // controlled popover (click can lose the race and drop onSelect).
                  event.preventDefault()
                  handleSelect(v.value)
                }}
                // Keyboard activation (Enter/Space) fires click, not pointerdown;
                // useOptimisticSelect ignores the repeat when both fire on mouse.
                onClick={() => handleSelect(v.value)}
                className={cn(
                  SELECTOR_OPTION_ROW,
                  v.value === displayValue && SELECTOR_OPTION_SELECTED
                )}
              >
                <span className="font-medium">{v.name}</span>
                {v.description && (
                  <span className={SELECTOR_OPTION_DESCRIPTION}>{v.description}</span>
                )}
              </button>
            ))
          ) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No matching models.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A popover selector for the legacy modes API. */
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
  const { displayValue, pending, select } = useOptimisticSelect(modes?.currentModeId, onSelect)

  if (!modes || modes.availableModes.length === 0) return null

  const current = modes.availableModes.find((m) => m.id === displayValue)

  const handleSelect = (modeId: string): void => {
    setOpen(false)
    select(modeId)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill disabled={disabled} chevron pending={pending}>
          <Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          {current?.name ?? label}
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className={SELECTOR_SECTION_LABEL}>{label}</div>
        {modes.availableModes.map((m) => (
          <button
            key={m.id}
            type="button"
            onPointerDown={(event) => {
              if ((event.button ?? 0) !== 0) return
              event.preventDefault()
              handleSelect(m.id)
            }}
            onClick={() => handleSelect(m.id)}
            className={cn(SELECTOR_OPTION_ROW, m.id === displayValue && SELECTOR_OPTION_SELECTED)}
          >
            <span className="font-medium">{m.name}</span>
            {m.description && <span className={SELECTOR_OPTION_DESCRIPTION}>{m.description}</span>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
