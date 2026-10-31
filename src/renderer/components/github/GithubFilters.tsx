import type { GithubListFilter } from '@shared/types/github.types'
import {
  pressedToggleClass,
  SEGMENTED_TRACK_CLASS,
  segmentClass
} from '@/components/ui/panel-styles'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const KIND_OPTIONS: ReadonlyArray<{ value: GithubListFilter['kind']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'issue', label: 'Issues' },
  { value: 'pr', label: 'PRs' }
]

const STATE_OPTIONS: ReadonlyArray<{ value: GithubListFilter['state']; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'merged', label: 'Merged' },
  { value: 'draft', label: 'Draft' },
  { value: 'all', label: 'All states' }
]

const TOGGLES: ReadonlyArray<{ key: 'assignedToMe' | 'reviewRequested'; label: string }> = [
  { key: 'assignedToMe', label: 'Assigned to me' },
  { key: 'reviewRequested', label: 'Review requested' }
]

interface GithubFiltersProps {
  filter: GithubListFilter
  onChange: (patch: Partial<GithubListFilter>) => void
}

/** Kind (segmented), state (select) and the two "involves me" toggles. */
export function GithubFilters({ filter, onChange }: GithubFiltersProps): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
      <div role="group" aria-label="Kind" className={cn(SEGMENTED_TRACK_CLASS, 'h-7')}>
        {KIND_OPTIONS.map((option) => {
          const active = filter.kind === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ kind: option.value })}
              className={cn(segmentClass(active), 'h-full flex-1 justify-center')}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Select
          value={filter.state}
          onValueChange={(value) => onChange({ state: value as GithubListFilter['state'] })}
        >
          <SelectTrigger
            aria-label="State"
            className="h-7 w-auto min-w-0 gap-1 rounded-md px-2 text-xs pointer-coarse:h-9"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {TOGGLES.map((toggle) => (
          <button
            key={toggle.key}
            type="button"
            aria-pressed={filter[toggle.key]}
            onClick={() => onChange({ [toggle.key]: !filter[toggle.key] })}
            className={cn(
              'h-7 shrink-0 rounded-md border px-2 text-xs transition-colors duration-150 ease-out pointer-coarse:h-9',
              'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring',
              pressedToggleClass(filter[toggle.key])
            )}
          >
            {toggle.label}
          </button>
        ))}
      </div>
    </div>
  )
}
