import { Zap } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { SessionConfigOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { SegmentedTrack } from './SegmentedTrack'

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
  onChange
}: {
  label: string
  value: string | undefined
  options: SessionConfigOption['options']
  disabled: boolean
  touch: boolean
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
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.name}
            </SelectItem>
          ))}
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
  touch
}: {
  thoughtLevel: SessionConfigOption | null
  effortValue: string | undefined
  onEffort: (value: string) => void
  fastMode: SessionConfigOption | null
  fastOn: boolean
  /** Null when Fast cannot change (no opposite value). */
  onToggleFast: (() => void) | null
  genericOptions: SessionConfigOption[]
  onSetConfig: (configId: string, valueId: string) => void
  disabled: boolean
  touch: boolean
}): React.JSX.Element | null {
  if (!thoughtLevel && !fastMode && genericOptions.length === 0) return null
  const grid = thoughtLevel ? effortGrid(thoughtLevel.options.length) : null

  return (
    <div
      data-testid="selector-footer"
      className={cn('flex flex-col gap-1', touch ? 'px-3 py-2' : 'p-1')}
    >
      {genericOptions.map((option) =>
        option.options.length <= MAX_OPTION_SEGMENTS ? (
          <SegmentedTrack
            key={option.id}
            id={`option-${option.id}`}
            label={option.name}
            touch={touch}
            // The caption takes only its text width; the values share the rest.
            template={`max-content repeat(${option.options.length}, minmax(0, 1fr))`}
            items={[
              {
                key: '\0label',
                kind: 'label' as const,
                label: captionFor(option),
                title: option.description ?? option.name
              },
              ...option.options.map((value) => ({
                key: value.value,
                label: value.name,
                title: value.description ?? undefined,
                selected: value.value === option.currentValue,
                disabled,
                onSelect: () => onSetConfig(option.id, value.value)
              }))
            ]}
          />
        ) : (
          <SelectTrack
            key={option.id}
            label={captionFor(option)}
            value={option.currentValue}
            options={option.options}
            disabled={disabled}
            touch={touch}
            onChange={(value) => onSetConfig(option.id, value)}
          />
        )
      )}
      {thoughtLevel || fastMode ? (
        <div className="flex items-stretch gap-1">
          {thoughtLevel && grid ? (
            <SegmentedTrack
              id="effort"
              label="Effort"
              touch={touch}
              columns={grid.columns}
              className="min-w-0 flex-1"
              items={thoughtLevel.options.map((option, i) => ({
                key: option.value,
                label: option.name,
                title: option.name,
                span: grid.spans[i],
                selected: option.value === effortValue,
                disabled,
                onSelect: () => onEffort(option.value)
              }))}
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
