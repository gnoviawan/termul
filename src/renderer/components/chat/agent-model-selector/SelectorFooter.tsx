import { Zap } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { SegmentedTrack } from './SegmentedTrack'
import { REJECTED_TITLE, useOptimisticSwitch, useRejectedOptionValues } from './use-option-values'

/** Values of a config option shown as segments next to its caption. */
const MAX_OPTION_SEGMENTS = 4
/** Effort levels that fit one row; more wrap into two rows. */
const MAX_EFFORT_ROW = 4

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * Grid for an effort switcher: one row up to 4 levels, else two rows (the
 * first row gets the extra level). Each row fills the full width, so 5 levels
 * are 3 + 2 on a 6-column grid. Fast never counts, so the layout does not
 * change when the agent adds or removes Fast for a model.
 */
export function effortGrid(count: number): { columns: number; spans: number[] } {
  if (count <= MAX_EFFORT_ROW) return { columns: count, spans: Array(count).fill(1) }
  const first = Math.ceil(count / 2)
  const second = count - first
  const columns = (first * second) / gcd(first, second)
  return {
    columns,
    spans: Array.from({ length: count }, (_, i) => (i < first ? columns / first : columns / second))
  }
}

/**
 * Short captions for agent options whose names do not fit a track caption.
 * Keyed by option category. The full name stays the accessible name.
 */
const SHORT_CAPTIONS: Record<string, string> = {
  // Codex: "Collaboration mode" (Default | Plan).
  collaboration_mode: 'Mode'
}

function captionFor(option: SessionConfigOption): string {
  return (option.category && SHORT_CAPTIONS[option.category]) || option.name
}

function SelectTrack({
  label,
  value,
  options,
  disabled,
  touch,
  rejected,
  onChange
}: {
  label: string
  value: string | undefined
  options: SessionConfigOption['options']
  disabled: boolean
  touch: boolean
  /** Values the agent rejected: rendered disabled with a hint (#1480). */
  rejected: Set<string>
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-0.5 rounded-lg bg-muted p-0.5">
      <span
        className={cn(
          'flex min-w-0 items-center justify-center truncate text-muted-foreground',
          touch ? 'h-11 text-sm' : 'h-7 text-xs'
        )}
      >
        {label}
      </span>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          aria-label={label}
          className={cn(
            'col-span-4 rounded-md border-0 bg-foreground/10 px-2 text-foreground',
            touch ? 'h-11 text-sm' : 'h-7 text-xs'
          )}
        >
          <SelectValue />
        </SelectTrigger>
        {/* Above the selector popover (z-[100]); at z-50 the list opened behind it. */}
        <SelectContent className="z-[110]">
          {options?.flatMap((option) =>
            typeof option.value === 'string' &&
            !(rejected.has(option.value) && option.value !== value) ? (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={disabled || rejected.has(option.value)}
              >
                {rejected.has(option.value) ? (
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate">{option.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      Not available
                    </span>
                  </span>
                ) : (
                  option.name
                )}
              </SelectItem>
            ) : (
              []
            )
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Fast mode as an icon toggle with a fixed place at the end of the effort row.
 * When the model has no Fast mode the slot stays, disabled, so the effort
 * switcher keeps its width when the user changes models.
 */
function FastToggle({
  fastMode,
  fastOn,
  onToggle,
  disabled,
  touch
}: {
  fastMode: SessionConfigOption | null
  fastOn: boolean
  onToggle: (() => void) | null
  disabled: boolean
  touch: boolean
}): React.JSX.Element {
  const label = fastMode ? fastMode.name : 'Fast mode is not available for this model'
  return (
    <div className="flex rounded-lg bg-muted p-0.5">
      <button
        type="button"
        aria-label={label}
        aria-pressed={fastMode ? fastOn : undefined}
        title={fastMode ? (fastMode.description ?? fastMode.name) : label}
        disabled={disabled || !fastMode || !onToggle}
        data-testid="selector-fast"
        data-press-feedback="off"
        onClick={onToggle ?? undefined}
        className={cn(
          'relative flex items-center justify-center self-stretch rounded-md',
          'transition-[color,background-color,transform] duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          'enabled:active:scale-[0.96] motion-reduce:active:scale-100',
          'disabled:cursor-not-allowed disabled:opacity-40',
          touch ? 'min-h-11 w-11' : 'min-h-7 w-7',
          // On: a filled bolt in the warning (yellow) token. Off: an outline
          // bolt. The shape change keeps the state clear without the color.
          fastOn
            ? 'bg-foreground/10 text-warning'
            : 'text-muted-foreground enabled:hover:text-foreground'
        )}
      >
        <Zap
          size={touch ? 16 : 14}
          fill={fastOn ? 'currentColor' : 'none'}
          aria-hidden="true"
          className="transition-[fill,color] duration-150 ease-out"
        />
      </button>
    </div>
  )
}

/**
 * On/off control for a boolean config option. Booleans have no value list, so
 * they render as a switch row instead of a track. Optimistic like the old
 * pill: the switch flips at once and reverts if the store rejects the set.
 */
function BooleanOptionRow({
  option,
  disabled,
  touch,
  onToggle
}: {
  option: SessionConfigOption
  disabled: boolean
  touch: boolean
  onToggle: (value: boolean) => void | Promise<void>
}): React.JSX.Element {
  const [on, toggle] = useOptimisticSwitch(option.currentValue === true, onToggle)
  return (
    <div
      data-selector-row=""
      className={cn(
        'flex items-center justify-between gap-3 rounded-lg px-2',
        'transition-[background-color] duration-150 ease-out hover:bg-foreground/10',
        touch ? 'min-h-11 py-2.5' : 'min-h-8 py-1.5'
      )}
    >
      <span
        className="min-w-0 truncate text-sm text-foreground"
        title={option.description ?? undefined}
      >
        {option.name}
      </span>
      <Switch checked={on} disabled={disabled} aria-label={option.name} onCheckedChange={toggle} />
    </div>
  )
}

/**
 * Rows for the agent's generic (non-effort) config options. Selecting a value
 * that the agent rejects (e.g. a tool advertised as a segment — #1480's
 * `web-fetch`) marks that value unavailable for the rest of the panel's life:
 * the segment greys out with a "not available" hint instead of staying a
 * clickable dead end that only produces an error toast.
 */
function GenericOptionRows({
  genericOptions,
  onSetConfig,
  disabled,
  touch,
  agentConfigId
}: {
  genericOptions: SessionConfigOption[]
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  disabled: boolean
  touch: boolean
  /** The agent whose option values these are; keys the persisted rejections. */
  agentConfigId: string | null
}): React.JSX.Element {
  const { isRejected, trySet } = useRejectedOptionValues(agentConfigId, genericOptions, onSetConfig)
  return (
    <>
      {genericOptions.map((option) => {
        if (option.type === 'boolean') {
          return (
            <BooleanOptionRow
              key={option.id}
              option={option}
              disabled={disabled}
              touch={touch}
              onToggle={(value) => trySet(option.id, value)}
            />
          )
        }
        const values = option.options ?? []
        // Grid + threshold count only the values that actually render: every
        // hidden rejection would otherwise leave an empty track column
        // (review).
        const visibleCount = values.filter(
          (value) =>
            typeof value.value === 'string' &&
            (value.value === option.currentValue || !isRejected(option.id, value.value))
        ).length
        return visibleCount <= MAX_OPTION_SEGMENTS && visibleCount > 0 ? (
          <SegmentedTrack
            key={option.id}
            id={`option-${option.id}`}
            label={option.name}
            touch={touch}
            // The caption takes only its text width; the values share the rest.
            template={`max-content repeat(${visibleCount}, minmax(0, 1fr))`}
            items={[
              {
                key: '\0label',
                kind: 'label' as const,
                label: captionFor(option),
                title: option.description ?? option.name
              },
              ...values.flatMap((value) => {
                if (typeof value.value !== 'string') return []
                const v = value.value
                const rejected = isRejected(option.id, v)
                // Rejected values are hidden from the track entirely (the user
                // sees only what the agent accepts). The one exception is the
                // currently-selected value — it stays visible (disabled) so a
                // rejection mid-flight never blanks the row's active state.
                if (rejected && v !== option.currentValue) return []
                return [
                  {
                    key: v,
                    label: value.name,
                    // Touch UIs never show `title`; fold the reason into the
                    // accessible name so screen readers announce it.
                    ariaLabel: rejected ? `${value.name} — ${REJECTED_TITLE}` : undefined,
                    title: rejected ? REJECTED_TITLE : (value.description ?? undefined),
                    selected: v === option.currentValue,
                    disabled: disabled || rejected,
                    onSelect: () => {
                      trySet(option.id, v).catch(() => {
                        /* marked unavailable; the toast already reported it */
                      })
                    }
                  }
                ]
              })
            ]}
          />
        ) : (
          <SelectTrack
            key={option.id}
            label={captionFor(option)}
            value={typeof option.currentValue === 'string' ? option.currentValue : undefined}
            options={values}
            disabled={disabled}
            touch={touch}
            rejected={
              new Set(
                values.flatMap((value) =>
                  typeof value.value === 'string' && isRejected(option.id, value.value)
                    ? [value.value]
                    : []
                )
              )
            }
            onChange={(value) => trySet(option.id, value)}
          />
        )
      })}
    </>
  )
}

/**
 * Selector footer for the agent that the composer controls: one track per
 * agent option (for example Cursor's Context 256K | 500K), then the Effort
 * switcher with the Fast toggle at its end. Effort is always a switcher.
 */
export function SelectorFooter({
  thoughtLevel,
  effortValue,
  onEffort,
  fastMode,
  fastOn,
  onToggleFast,
  genericOptions,
  onSetConfig,
  disabled,
  touch,
  agentConfigId
}: {
  thoughtLevel: SessionConfigOption | null
  effortValue: string | undefined
  onEffort: (value: string) => void
  fastMode: SessionConfigOption | null
  fastOn: boolean
  /** Null when Fast cannot change (no opposite value). */
  onToggleFast: (() => void) | null
  genericOptions: SessionConfigOption[]
  onSetConfig: (configId: string, valueId: string | boolean) => void | Promise<void>
  disabled: boolean
  touch: boolean
  agentConfigId: string | null
}): React.JSX.Element | null {
  if (!thoughtLevel && !fastMode && genericOptions.length === 0) return null
  const effortOptions = thoughtLevel?.options ?? []
  const grid = thoughtLevel ? effortGrid(effortOptions.length) : null

  return (
    <div
      data-testid="selector-footer"
      className={cn('flex flex-col gap-1', touch ? 'px-3 py-2' : 'p-1')}
    >
      {/* Keyed by agent: a selector can switch agents while mounted, and the
          previous agent's rejection state must not leak into the new one
          (review) — a key remount gives every agent a fresh state + preload. */}
      <GenericOptionRows
        key={agentConfigId ?? 'no-agent'}
        genericOptions={genericOptions}
        onSetConfig={onSetConfig}
        disabled={disabled}
        touch={touch}
        agentConfigId={agentConfigId}
      />
      {thoughtLevel || fastMode ? (
        <div className="flex items-stretch gap-1">
          {thoughtLevel && grid && effortOptions.length > 0 ? (
            <SegmentedTrack
              id="effort"
              label="Effort"
              touch={touch}
              columns={grid.columns}
              className="min-w-0 flex-1"
              items={effortOptions.flatMap((option, i) => {
                if (typeof option.value !== 'string') return []
                const v = option.value
                return [
                  {
                    key: v,
                    label: option.name,
                    title: option.name,
                    span: grid.spans[i],
                    selected: v === effortValue,
                    disabled,
                    onSelect: () => onEffort(v)
                  }
                ]
              })}
            />
          ) : (
            <span className="flex-1" />
          )}
          <FastToggle
            fastMode={fastMode}
            fastOn={fastOn}
            onToggle={onToggleFast}
            disabled={disabled}
            touch={touch}
          />
        </div>
      ) : null}
    </div>
  )
}
