import type { GithubItemDetail } from '@shared/types/github.types'
import { type ComponentPropsWithoutRef, forwardRef } from 'react'
import { Plus, Tag, User } from '@/components/icons'
import { FOCUS_RING_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { WriteGate } from '@/components/ui/write-gate'
import { cn } from '@/lib/utils'
import {
  type GithubItemEdit,
  type GithubItemRef,
  githubRepoMetaKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { reportGithubWriteFailure, useGithubItemActions } from './GithubItemMenu'
import { GithubPicker } from './GithubPicker'
import { GithubAvatar, LabelChip, LabelDot } from './github-status'

export type GithubMetaEditor = 'labels' | 'assignees'

interface GithubItemMetaProps {
  itemRef: GithubItemRef
  detail: GithubItemDetail
  /** `rows` above the tabs on a narrow pane; `sidebar` beside the page on a wide one. */
  layout: 'rows' | 'sidebar'
  /** The open picker; the ⋯ menu opens them too. */
  editing: GithubMetaEditor | null
  onEditingChange: (editing: GithubMetaEditor | null) => void
}

function added(next: readonly string[], prev: readonly string[]): string[] {
  return next.filter((value) => !prev.includes(value))
}

/** "Done · +1 label", "Done · +2 −1 assignees", or "Done" with no change. */
function doneLabel(next: readonly string[], prev: readonly string[], noun: string): string {
  const adds = added(next, prev).length
  const removes = added(prev, next).length
  if (adds + removes === 0) return 'Done'
  const parts = [adds > 0 && `+${adds}`, removes > 0 && `−${removes}`].filter(Boolean).join(' ')
  return `Done · ${parts} ${adds + removes === 1 ? noun : `${noun}s`}`
}

/**
 * The item's labels and assignees, each with its picker. Done applies the
 * difference on GitHub and waits for the re-read, so the chips show what
 * GitHub reports; a refusal toasts and keeps the picker open.
 */
export function GithubItemMeta({
  itemRef,
  detail,
  layout,
  editing,
  onEditingChange
}: GithubItemMetaProps): React.JSX.Element {
  const meta = useGithubStore((s) =>
    resourceOf(s.repoMeta[githubRepoMetaKey(itemRef.cwd, itemRef.repo)])
  )
  const actions = useGithubItemActions(itemRef, detail)
  const { item } = detail
  const labelNames = item.labels.map((label) => label.name)
  const status = meta.data ? 'ready' : meta.status === 'error' ? 'error' : 'loading'

  const openChange = (editor: GithubMetaEditor) => (open: boolean) => {
    if (open) actions.loadMeta()
    onEditingChange(open ? editor : null)
  }

  const applyEdit = async (what: string, edit: GithubItemEdit): Promise<boolean> => {
    const nothing = Object.values(edit).every((list) => !list || list.length === 0)
    if (nothing) return true
    const result = await useGithubStore.getState().editItem(itemRef, edit)
    if (result.success) return true
    reportGithubWriteFailure(what, result)
    return false
  }

  const sidebar = layout === 'sidebar'

  const labelPicker = (
    <GithubPicker
      open={editing === 'labels'}
      onOpenChange={openChange('labels')}
      trigger={
        sidebar ? (
          <SidebarEditButton label="Edit labels" icon={<Tag size={14} aria-hidden="true" />} />
        ) : (
          <AddButton label="Edit labels" />
        )
      }
      title="Labels"
      hint="Applied on GitHub when you tap Done"
      searchLabel="Find or create a label"
      status={status}
      error={meta.error}
      options={(meta.data?.labels ?? []).map((label) => ({
        value: label.name,
        label: label.name,
        description: label.description,
        leading: <LabelDot color={label.color} />
      }))}
      initial={labelNames}
      gated={actions.gated}
      applyLabel={(selected) => doneLabel(selected, labelNames, 'label')}
      onApply={(selected, opened) =>
        applyEdit('update the labels', {
          addLabels: added(selected, opened),
          removeLabels: added(opened, selected)
        })
      }
      renderSelected={(name, remove) => {
        const color = meta.data?.labels.find((label) => label.name === name)?.color ?? ''
        return <LabelChip label={{ name, color }} size="md" surface="--popover" onRemove={remove} />
      }}
      create={{
        onCreate: async (label) => {
          const result = await useGithubStore
            .getState()
            .createLabel(itemRef.cwd, itemRef.repo, label)
          if (result.success) return result.data.label.name
          reportGithubWriteFailure('create the label', result)
          return null
        }
      }}
    />
  )

  const assigneePicker = (
    <GithubPicker
      open={editing === 'assignees'}
      onOpenChange={openChange('assignees')}
      trigger={
        sidebar ? (
          <SidebarEditButton label="Edit assignees" icon={<User size={14} aria-hidden="true" />} />
        ) : (
          <AddButton label="Edit assignees" />
        )
      }
      title="Assignees"
      hint="Applied on GitHub when you tap Done"
      searchLabel="Find a person"
      status={status}
      error={meta.error}
      options={(meta.data?.assignableUsers ?? []).map((login) => ({
        value: login,
        label: login,
        leading: <GithubAvatar login={login} size="sm" />
      }))}
      initial={item.assignees}
      gated={actions.gated}
      applyLabel={(selected) => doneLabel(selected, item.assignees, 'assignee')}
      onApply={(selected, opened) =>
        applyEdit('update the assignees', {
          addAssignees: added(selected, opened),
          removeAssignees: added(opened, selected)
        })
      }
    />
  )

  const labelChips =
    item.labels.length > 0 ? (
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {item.labels.map((label) => (
          <LabelChip key={label.name} label={label} size="md" />
        ))}
      </div>
    ) : (
      <span className="text-xs text-muted-foreground">None yet</span>
    )

  const assigneeList =
    item.assignees.length > 0 ? (
      <ul className="flex min-w-0 flex-col gap-1.5">
        {item.assignees.map((login) => (
          <li key={login} className="flex min-w-0 items-center gap-2 text-xs text-foreground">
            <GithubAvatar login={login} size="sm" />
            <span className="min-w-0 truncate">{login}</span>
          </li>
        ))}
      </ul>
    ) : null

  const assignYourself =
    actions.selfAction === 'assign' ? (
      <WriteGate gated={actions.gated} className="self-start">
        <button
          type="button"
          disabled={actions.gated || actions.busy}
          onClick={actions.toggleSelf}
          className={cn(
            'rounded-md text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-60',
            FOCUS_RING_CLASS
          )}
        >
          Assign yourself
        </button>
      </WriteGate>
    ) : null

  const assignees = assigneeList ?? (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span>No one</span>
      {assignYourself && (
        <>
          <span aria-hidden="true">·</span>
          {assignYourself}
        </>
      )}
    </div>
  )

  if (sidebar) {
    return (
      <div className="flex flex-col divide-y divide-border">
        <section aria-label="Labels" className="flex flex-col gap-2 pb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-foreground">Labels</h2>
            {labelPicker}
          </div>
          {labelChips}
        </section>
        <section aria-label="Assignees" className="flex flex-col gap-2 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-foreground">Assignees</h2>
            {assigneePicker}
          </div>
          {assignees}
          {assigneeList && assignYourself}
        </section>
      </div>
    )
  }

  return (
    <dl className="flex flex-col divide-y divide-border border-y border-border">
      <div className="flex min-h-12 min-w-0 items-center gap-3 py-1.5">
        <dt className="w-20 shrink-0 text-xs text-muted-foreground">Labels</dt>
        <dd className="min-w-0 flex-1">{labelChips}</dd>
        {labelPicker}
      </div>
      <div className="flex min-h-12 min-w-0 items-center gap-3 py-1.5">
        <dt className="w-20 shrink-0 text-xs text-muted-foreground">Assignees</dt>
        <dd className="min-w-0 flex-1">{assignees}</dd>
        {assigneePicker}
      </div>
    </dl>
  )
}

const AddButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { label: string }
>(function AddButton({ label, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground pointer-coarse:size-11',
        FOCUS_RING_CLASS,
        className
      )}
      {...props}
    >
      <Plus size={16} aria-hidden="true" />
    </button>
  )
})

const SidebarEditButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<'button'> & { label: string; icon: React.ReactNode }
>(function SidebarEditButton({ label, icon, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(PANEL_ICON_BUTTON_CLASS, className)}
      {...props}
    >
      {icon}
    </button>
  )
})
