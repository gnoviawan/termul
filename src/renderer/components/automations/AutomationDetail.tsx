import type {
  AutomationRun,
  AutomationDetail as Detail,
  RunId
} from '@shared/types/automation.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AlertCircle, KeyRound, Loader2, Trash2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { Switch } from '@/components/ui/switch'
import {
  approveAutomation,
  deleteAutomation,
  markAutomationSeen,
  runAutomationNow,
  setAutomationEnabled
} from '@/lib/automation-api'
import { cn } from '@/lib/utils'
import { AutomationDiagram } from './AutomationDiagram'
import { AutomationSecretsDialog } from './AutomationSecretsDialog'
import {
  automationState,
  formatDateTime,
  formatDuration,
  nodeLabels,
  STATE_PRESENTATION,
  STATUS_PRESENTATION
} from './automation-format'
import { RunPolicyCard } from './RunPolicyCard'

interface AutomationDetailProps {
  detail: Detail
  runs: AutomationRun[] | null
  narrow: boolean
  isVisible: boolean
  onOpenRun: (runId: RunId) => void
  onDeleted: () => void
  onChanged: () => void
}

type Busy = 'approve' | 'run' | 'enable' | 'delete' | null

export function AutomationDetail({
  detail,
  runs,
  narrow,
  isVisible,
  onOpenRun,
  onDeleted,
  onChanged
}: AutomationDetailProps): React.JSX.Element {
  const { automation, issues, policy } = detail
  const [busy, setBusy] = useState<Busy>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [secretsOpen, setSecretsOpen] = useState(false)
  const state = STATE_PRESENTATION[automationState(automation)]
  const labels = nodeLabels(automation.graph.nodes)
  const secretNames = [...new Set(policy.secrets.flatMap((entry) => entry.names))]

  // The runs list is on screen: its failures count as seen.
  const unseen = automation.unseen_failures
  useEffect(() => {
    if (isVisible && unseen > 0) void markAutomationSeen(automation.id)
  }, [isVisible, unseen, automation.id])

  const act = async <T,>(
    kind: Exclude<Busy, null>,
    failure: string,
    call: () => Promise<IpcResult<T>>
  ): Promise<IpcResult<T>> => {
    setBusy(kind)
    const result = await call()
    setBusy(null)
    if (!result.success) toast.error(`${failure}: ${result.error}`)
    onChanged()
    return result
  }

  const runNow = async (): Promise<void> => {
    const result = await act('run', 'Could not start the run', () =>
      runAutomationNow(automation.id)
    )
    if (result.success) onOpenRun(result.data.id)
  }

  const remove = async (): Promise<void> => {
    setConfirmDelete(false)
    const result = await act('delete', 'Could not delete the automation', () =>
      deleteAutomation(automation.id)
    )
    if (result.success) onDeleted()
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-medium text-foreground">{automation.name}</h2>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 text-3xs font-medium leading-5',
              state.className
            )}
          >
            {state.label}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0 text-destructive pointer-coarse:h-11"
            disabled={busy === 'delete'}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} />
            Delete
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`automation-enabled-${automation.id}`}
            className="flex min-h-9 items-center gap-2 pr-2 text-sm text-foreground pointer-coarse:min-h-11"
          >
            <Switch
              id={`automation-enabled-${automation.id}`}
              checked={automation.enabled}
              disabled={busy === 'enable'}
              onCheckedChange={(enabled) =>
                void act('enable', 'Could not change the automation', () =>
                  setAutomationEnabled(automation.id, enabled)
                )
              }
            />
            Enabled
          </label>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={busy === 'run'}
            onClick={() => void runNow()}
          >
            {busy === 'run' ? <Loader2 size={14} className="animate-spin" /> : null}
            Run now
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => setSecretsOpen(true)}
          >
            <KeyRound size={14} />
            Secrets
          </Button>
        </div>
      </header>

      {issues.length > 0 && (
        <section aria-labelledby="automation-issues" className="flex flex-col gap-1.5">
          <h3 id="automation-issues" className="text-xs font-medium text-destructive">
            {issues.length === 1 ? '1 issue' : `${issues.length} issues`} to fix before approval
          </h3>
          <ul className="flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li
                // Issues carry no id; the same code can repeat on one node.
                key={`${issue.code}-${issue.node_id ?? ''}-${index}`}
                className="flex gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                <AlertCircle size={14} className="mt-px shrink-0" />
                <span className="min-w-0 break-words">
                  {issue.node_id && (
                    <span className="font-medium">
                      {labels.get(issue.node_id) ?? issue.node_id}:{' '}
                    </span>
                  )}
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RunPolicyCard
        automation={automation}
        policy={policy}
        issues={issues}
        approving={busy === 'approve'}
        onApprove={() =>
          void act('approve', 'Could not approve', () =>
            approveAutomation(automation.id, automation.revision)
          )
        }
      />

      <section aria-labelledby="automation-diagram-title" className="flex flex-col gap-2">
        <h3 id="automation-diagram-title" className="text-xs font-medium text-muted-foreground">
          Diagram
        </h3>
        <AutomationDiagram graph={automation.graph} trigger={automation.trigger} narrow={narrow} />
      </section>

      <section aria-labelledby="automation-runs-title" className="flex flex-col gap-2">
        <h3 id="automation-runs-title" className="text-xs font-medium text-muted-foreground">
          Runs
        </h3>
        <RunList runs={runs} onOpenRun={onOpenRun} />
      </section>

      <AutomationSecretsDialog
        projectId={automation.project_id}
        referenced={secretNames}
        open={secretsOpen}
        onOpenChange={setSecretsOpen}
      />
      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete automation"
        message={`Delete "${automation.name}"? It stops running and its run history is removed. This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

function RunList({
  runs,
  onOpenRun
}: {
  runs: AutomationRun[] | null
  onOpenRun: (runId: RunId) => void
}): React.JSX.Element {
  if (runs === null) return <p className="text-xs text-muted-foreground">Loading runs…</p>
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs yet. Use Run now to try it.</p>
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
      {runs.map((run) => {
        const status = STATUS_PRESENTATION[run.status]
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onOpenRun(run.id)}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-foreground/[0.03]',
                FOCUS_RING_CLASS
              )}
            >
              <span className={cn('w-20 shrink-0 font-medium', status.className)}>
                {status.label}
              </span>
              <span className="min-w-0 flex-1 truncate tabular-nums text-foreground">
                {formatDateTime(run.started_at)}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {run.finished_at === null ? '' : formatDuration(run.finished_at - run.started_at)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
