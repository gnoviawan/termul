import type { GithubLabelMode, GithubListFilter, GithubSort } from '@shared/types/github.types'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ArrowDown, CircleDot, Search, Tag, User } from '@/components/icons'
import {
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  SEGMENTED_TRACK_CLASS,
  segmentClass
} from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { githubRepoMetaKey, resourceOf, useGithubStore } from '@/stores/github-store'
import { type ChoiceOption, FilterChip, GithubChoiceMenu } from './GithubChoiceMenu'
import { GithubPicker } from './GithubPicker'
import { LabelChip, LabelDot } from './github-status'

const KIND_OPTIONS: ReadonlyArray<{ value: GithubListFilter['kind']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'issue', label: 'Issues' },
  { value: 'pr', label: 'PRs' }
]

const STATE_OPTIONS: ReadonlyArray<ChoiceOption<GithubListFilter['state']>> = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'merged', label: 'Merged' },
  { value: 'draft', label: 'Draft' },
  { value: 'all', label: 'All states' }
]

const SORT_OPTIONS: ReadonlyArray<ChoiceOption<GithubSort>> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest' },
  { value: 'comments', label: 'Most commented' }
]

const MODE_OPTIONS: ReadonlyArray<{ value: GithubLabelMode; label: string }> = [
  { value: 'any', label: 'Match any' },
  { value: 'all', label: 'Match all' },
  { value: 'exclude', label: 'Without' }
]

/** "Whose items" as one choice: the assignee filter, or review requested (PRs only). */
type InvolvementChoice = 'anyone' | 'me' | 'unassigned' | 'review' | `user:${string}`

function involvementOf(filter: GithubListFilter): InvolvementChoice {
  if (filter.reviewRequested) return 'review'
  return filter.assignee.kind === 'user' ? `user:${filter.assignee.login}` : filter.assignee.kind
}

function involvementPatch(choice: InvolvementChoice): Partial<GithubListFilter> {
  if (choice === 'review') return { assignee: { kind: 'anyone' }, reviewRequested: true }
  const assignee: GithubListFilter['assignee'] = choice.startsWith('user:')
    ? { kind: 'user', login: choice.slice('user:'.length) }
    : { kind: choice as 'anyone' | 'me' | 'unassigned' }
  return { assignee, reviewRequested: false }
}

const SEARCH_DEBOUNCE_MS = 350

interface GithubFiltersProps {
  cwd: string
  filter: GithubListFilter
  onChange: (patch: Partial<GithubListFilter>) => void
  /** Sits at the end of the kind row (the panel's Refresh). */
  action?: ReactNode
}

/**
 * The list's search field, kind segment, and filter chips (state, labels,
 * assignee, sort), then the active labels as removable chips. Every change
 * reloads the list through the store.
 */
export function GithubFilters({
  cwd,
  filter,
  onChange,
  action
}: GithubFiltersProps): React.JSX.Element {
  const involvement = involvementOf(filter)
  const meta = useRepoMeta(cwd, filter.repo)
  const people = new Set(meta.data?.assignableUsers ?? [])
  if (meta.data) people.delete(meta.data.viewer)
  if (filter.assignee.kind === 'user') people.add(filter.assignee.login)
  const involvementOptions: ChoiceOption<InvolvementChoice>[] = [
    { value: 'anyone', label: 'Anyone' },
    { value: 'me', label: 'Assigned to me' },
    { value: 'unassigned', label: 'Unassigned' },
    ...(filter.kind === 'issue' ? [] : [{ value: 'review' as const, label: 'Review requested' }]),
    ...[...people].map((login) => ({
      value: `user:${login}` as const,
      label: `Assigned to ${login}`
    }))
  ]

  return (
    <div className="flex shrink-0 flex-col gap-2 px-2 pt-1 pb-2">
      {/* Keyed by working copy: a pending search never commits to the next one. */}
      <SearchField key={cwd} value={filter.search} onCommit={(search) => onChange({ search })} />
      <div className="flex min-w-0 items-center gap-1">
        <div
          role="group"
          aria-label="Kind"
          className={cn(SEGMENTED_TRACK_CLASS, 'h-7 min-w-0 flex-1 pointer-coarse:h-10')}
        >
          {KIND_OPTIONS.map((option) => {
            const active = filter.kind === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange(
                    // Review requests are PR-only: picking Issues drops that filter.
                    option.value === 'issue' && filter.reviewRequested
                      ? { kind: option.value, reviewRequested: false }
                      : { kind: option.value }
                  )
                }
                className={cn(
                  segmentClass(active),
                  'h-full flex-1 justify-center pointer-coarse:text-sm'
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
        {action}
      </div>
      <div className="-mx-2 flex min-w-0 items-center gap-1.5 overflow-x-auto px-2 [scrollbar-width:none]">
        <GithubChoiceMenu
          title="State"
          icon={<CircleDot size={12} aria-hidden="true" />}
          value={filter.state}
          options={STATE_OPTIONS}
          neutral="open"
          onChange={(state) => onChange({ state })}
        />
        <LabelFilter cwd={cwd} filter={filter} onChange={onChange} />
        <GithubChoiceMenu
          title="Assignee"
          icon={<User size={12} aria-hidden="true" />}
          value={involvement}
          options={involvementOptions}
          neutral="anyone"
          onChange={(choice) => onChange(involvementPatch(choice))}
          onOpen={() => {
            if (!meta.data && meta.status !== 'loading') {
              void useGithubStore.getState().loadRepoMeta(cwd, filter.repo)
            }
          }}
        />
        <GithubChoiceMenu
          title="Sort"
          icon={<ArrowDown size={12} aria-hidden="true" />}
          value={filter.sort}
          options={SORT_OPTIONS}
          neutral="updated"
          onChange={(sort) => onChange({ sort })}
        />
      </div>
      {filter.labels.length > 0 && <ActiveLabels cwd={cwd} filter={filter} onChange={onChange} />}
    </div>
  )
}

/** Search text, pushed to the filter after a pause or on Enter. */
function SearchField({
  value,
  onCommit
}: {
  value: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const committed = useRef(value)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // "Clear all" or another working copy's filter replaces the text from outside.
  useEffect(() => {
    committed.current = value
    setDraft(value)
  }, [value])

  useEffect(() => {
    if (draft === committed.current) return
    const timer = setTimeout(() => {
      // Enter may have committed this text already.
      if (draft === committed.current) return
      committed.current = draft
      onCommitRef.current(draft)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  return (
    <div className="relative">
      <Search size={13} aria-hidden="true" className={PANEL_FIELD_ICON_CLASS} />
      <input
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft !== committed.current) {
            committed.current = draft
            onCommit(draft)
          }
        }}
        placeholder="Search issues and PRs"
        aria-label="Search issues and pull requests"
        className={cn(PANEL_FIELD_CLASS, 'h-8 w-full pl-8 pr-2 pointer-coarse:h-11')}
      />
    </div>
  )
}

function useRepoMeta(cwd: string, repo: GithubListFilter['repo']) {
  return useGithubStore((s) => resourceOf(s.repoMeta[githubRepoMetaKey(cwd, repo)]))
}

function LabelFilter({ cwd, filter, onChange }: GithubFiltersProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<GithubLabelMode>(filter.labelMode)
  const meta = useRepoMeta(cwd, filter.repo)
  const count = filter.labels.length

  const onOpenChange = (next: boolean): void => {
    if (next) {
      setMode(filter.labelMode)
      if (!meta.data) void useGithubStore.getState().loadRepoMeta(cwd, filter.repo)
    }
    setOpen(next)
  }

  return (
    <GithubPicker
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <FilterChip
          active={count > 0}
          count={count}
          icon={<Tag size={12} aria-hidden="true" />}
          aria-label={count > 0 ? `Labels: ${filter.labels.join(', ')}` : 'Labels'}
        >
          Labels
        </FilterChip>
      }
      title="Filter by label"
      searchLabel="Find a label"
      status={meta.data ? 'ready' : meta.status === 'error' ? 'error' : 'loading'}
      error={meta.error}
      options={(meta.data?.labels ?? []).map((label) => ({
        value: label.name,
        label: label.name,
        description: label.description,
        leading: <LabelDot color={label.color} />
      }))}
      initial={filter.labels}
      clearable
      toolbar={
        <div
          role="group"
          aria-label="Match"
          className={cn(SEGMENTED_TRACK_CLASS, 'h-7 shrink-0 pointer-coarse:h-10')}
        >
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              onClick={() => setMode(option.value)}
              className={cn(
                segmentClass(mode === option.value),
                'h-full flex-1 justify-center pointer-coarse:text-sm'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
      applyLabel={(selected) =>
        selected.length === 0
          ? 'Show all'
          : `Show results · ${selected.length} ${selected.length === 1 ? 'label' : 'labels'}`
      }
      onApply={(labels) => {
        onChange({ labels, labelMode: mode })
        return true
      }}
    />
  )
}

const MODE_PREFIX: Record<GithubLabelMode, string | null> = {
  any: null,
  all: 'All of',
  exclude: 'Without'
}

function ActiveLabels({ cwd, filter, onChange }: GithubFiltersProps): React.JSX.Element {
  const meta = useRepoMeta(cwd, filter.repo)
  const metaMissing = !meta.data && meta.status === 'idle'
  // The chips take their colours from the repository's labels.
  useEffect(() => {
    if (metaMissing) void useGithubStore.getState().loadRepoMeta(cwd, filter.repo)
  }, [metaMissing, cwd, filter.repo])
  const colorOf = new Map((meta.data?.labels ?? []).map((label) => [label.name, label.color]))
  const prefix = MODE_PREFIX[filter.labelMode]
  return (
    <div
      role="group"
      aria-label="Active label filters"
      className="flex flex-wrap items-center gap-1.5"
    >
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      {filter.labels.map((name) => (
        <LabelChip
          key={name}
          size="md"
          label={{ name, color: colorOf.get(name) ?? '' }}
          onRemove={() => onChange({ labels: filter.labels.filter((label) => label !== name) })}
        />
      ))}
      <button
        type="button"
        onClick={() => onChange({ labels: [], labelMode: 'any' })}
        className="rounded-md px-1 text-xs font-medium text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Clear all
      </button>
    </div>
  )
}
