import type {
  AutomationNode,
  AutomationRun,
  AutomationStep,
  RunTrigger
} from '@shared/types/automation.types'
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cancelAutomationRun } from '@/lib/automation-api'
import { cn } from '@/lib/utils'
import {
  formatDateTime,
  formatDuration,
  NODE_KIND_PRESENTATION,
  STATUS_PRESENTATION
} from './automation-format'
import { layoutGraph } from './automation-layout'
import { useRunSteps } from './use-automations'

const TRIGGER_LABEL: Record<RunTrigger, string> = {
  scheduled: 'Scheduled',
  catch_up: 'Catch-up',
  manual: 'Manual'
}

const ORDER_METRICS = { nodeWidth: 1, nodeHeight: 1, gapX: 0, gapY: 0 }

export function AutomationRunDetail({ run }: { run: AutomationRun }): React.JSX.Element {
  const { data: steps, error } = useRunSteps(run)
  const [cancelling, setCancelling] = useState(false)
  // Steps in graph order (by rank, then row position) of the run's own snapshot.
  const nodes = useMemo(() => {
    const placed = layoutGraph(run.graph, ORDER_METRICS).nodes
    const byId = new Map<string, AutomationNode>(run.graph.nodes.map((node) => [node.id, node]))
    return placed
      .slice()
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .flatMap((p) => byId.get(p.id) ?? [])
  }, [run.graph])
  const stepOf = new Map((steps ?? []).map((step) => [step.node_id, step]))

  const status = STATUS_PRESENTATION[run.status]
  const cancel = async (): Promise<void> => {
    setCancelling(true)
    await cancelAutomationRun(run.id)
    setCancelling(false)
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className={cn('text-sm font-medium', status.className)}>{status.label}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {TRIGGER_LABEL[run.trigger]} · {formatDateTime(run.started_at)}
          {run.finished_at !== null &&
            ` · took ${formatDuration(run.finished_at - run.started_at)}`}
          {` · revision ${run.revision}`}
        </span>
        {run.status === 'running' && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto pointer-coarse:h-11"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            Cancel run
          </Button>
        )}
      </header>
      {run.stop_reason && <p className="text-xs text-destructive">{run.stop_reason}</p>}
      {run.summary && <p className="text-sm text-foreground">{run.summary}</p>}
      {error && <p className="text-xs text-destructive">Could not load the steps: {error}</p>}

      <ol className="flex flex-col gap-2" aria-label="Steps">
        {nodes.map((node) => (
          <StepRow
            key={node.id}
            label={node.label}
            kind={node.spec.kind}
            step={stepOf.get(node.id) ?? null}
            loading={steps === null}
          />
        ))}
      </ol>
    </div>
  )
}

function StepRow({
  label,
  kind,
  step,
  loading
}: {
  label: string
  kind: keyof typeof NODE_KIND_PRESENTATION
  step: AutomationStep | null
  loading: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { Icon } = NODE_KIND_PRESENTATION[kind]
  const status = step ? STATUS_PRESENTATION[step.status] : null
  const duration =
    step?.started_at != null && step.finished_at != null
      ? formatDuration(step.finished_at - step.started_at)
      : null
  const hasOutput = step !== null && step.output !== null && step.output !== undefined

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
        {duration && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{duration}</span>
        )}
        {step?.status === 'running' && (
          <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
        )}
        <span className={cn('shrink-0 text-xs', status?.className ?? 'text-muted-foreground')}>
          {status?.label ?? (loading ? '' : 'Not reached')}
        </span>
      </div>
      {step?.error && (
        <p className="border-t border-border px-3 py-2 font-mono text-xs break-words text-destructive">
          {step.error}
        </p>
      )}
      {hasOutput && (
        <div className="border-t border-border">
          <button
            type="button"
            className={cn(
              'flex min-h-9 w-full items-center gap-1 px-3 text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11',
              FOCUS_RING_CLASS
            )}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Output
          </button>
          {open && (
            <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-2xs text-secondary-foreground">
              {JSON.stringify(step.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}
