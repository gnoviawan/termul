import { Brain } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import type { AcpSession } from '@/stores/acp-store'
import { ComposerPill } from './ComposerPill'
import { KNOWN_CATEGORY_HEADINGS } from './slash-menu-model'

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
 */
export function ConfigChip({
  option,
  disabled,
  onSelect,
  promoted = false,
  searchable = false,
  maxVisibleOptions
}: {
  option: SessionConfigOption
  disabled: boolean
  onSelect: (valueId: string) => void
  promoted?: boolean
  searchable?: boolean
  maxVisibleOptions?: number
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const current = option.options.find((o) => o.value === option.currentValue)
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
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill disabled={disabled} chevron>
          {promoted && <Brain size={13} className="shrink-0 text-muted-foreground" />}
          {current?.name ?? fallbackLabel}
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className="label-group px-2 py-1 text-muted-foreground/70">
          {promoted ? fallbackLabel : option.name}
        </div>
        {showSearch && (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models..."
            aria-label="Search models"
            className="mb-1 w-full rounded-md bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary/40"
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
                onClick={() => {
                  setQuery('')
                  onSelect(v.value)
                }}
                className={cn(
                  'flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-accent',
                  v.value === option.currentValue && 'bg-accent/50'
                )}
              >
                <span className="font-medium">{v.name}</span>
                {v.description && (
                  <span className="text-xs text-muted-foreground">{v.description}</span>
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
  onSelect: (modeId: string) => void
  label?: string
}): React.JSX.Element | null {
  const modes = session.modes
  if (!modes || modes.availableModes.length === 0) return null
  const current = modes.availableModes.find((m) => m.id === modes.currentModeId)
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <ComposerPill disabled={disabled} chevron>
          {current?.name ?? label}
        </ComposerPill>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-1">
        <div className="label-group px-2 py-1 text-muted-foreground/70">{label}</div>
        {modes.availableModes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
            className={cn(
              'flex w-full flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-accent',
              m.id === modes.currentModeId && 'bg-accent/50'
            )}
          >
            <span className="font-medium">{m.name}</span>
            {m.description && (
              <span className="text-xs text-muted-foreground">{m.description}</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
