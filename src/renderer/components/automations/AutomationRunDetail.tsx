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
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cancelAutomationRun } from '@/lib/automation-api'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
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
  const gated = !useServerAdmitsRemoteWrites()
  // Steps in graph order (by rank, then row position) of the run's own snapshot.
  const nodes = useMemo(() => {
    const placed = layoutGraph(run.graph, ORDER_METRICS).nodes
    const byId = new Map<string, AutomationNode>(run.graph.nodes.map((node) => [node.id, node]))
    return placed
      .slice()
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .flatMap((p) => byId.get(p.id) ?? [])
  }, [run.graph])
  const stepsOf = groupSteps(steps ?? [])

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
          <WriteGate gated={gated} className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="ml-auto pointer-coarse:h-11"
              disabled={gated || cancelling}
              onClick={() => void cancel()}
            >
              Cancel run
            </Button>
          </WriteGate>
        )}
      </header>
      {gated && run.status === 'running' && (
        <p className="text-xs text-muted-foreground">{READ_ONLY_SERVER_REASON}</p>
      )}
      {run.stop_reason && <p className="text-xs text-destructive">{run.stop_reason}</p>}
      {run.summary && <p className="text-sm text-foreground">{run.summary}</p>}
      {error && <p className="text-xs text-destructive">Could not load the steps: {error}</p>}

      <ol className="flex flex-col gap-2" aria-label="Steps">
        {nodes.map((node) => (
          <StepRow
            key={node.id}
            label={node.label}
            kind={node.spec.kind}
            steps={stepsOf.get(node.id) ?? []}
            loading={steps === null}
          />
        ))}
      </ol>
    </div>
  )
}

/**
 * A node's rows: one, or one per iteration for a node inside a for_each
 * body, in iteration order. The last one is the node's latest status.
 */
function groupSteps(steps: AutomationStep[]): Map<string, AutomationStep[]> {
  const byNode = new Map<string, AutomationStep[]>()
  for (const step of steps) byNode.set(step.node_id, [...(byNode.get(step.node_id) ?? []), step])
  for (const rows of byNode.values()) {
    rows.sort((a, b) => (a.iteration ?? -1) - (b.iteration ?? -1))
  }
  return byNode
}

function StepRow({
  label,
  kind,
  steps,
  loading
}: {
  label: string
  kind: keyof typeof NODE_KIND_PRESENTATION
  steps: AutomationStep[]
  loading: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { Icon } = NODE_KIND_PRESENTATION[kind]
  const step = steps.at(-1) ?? null
  const iterations = steps.filter((row) => row.iteration !== null)

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex min-h-11 items-center gap-2 px-3 py-2">
        <Icon size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
        {iterations.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {iterations.length} {iterations.length === 1 ? 'iteration' : 'iterations'}
          </span>
        ) : (
          <StepDuration step={step} />
        )}
        <StepStatusLabel step={step} loading={loading} />
      </div>
      {iterations.length > 0 ? (
        <Disclosure label="Iterations" open={open} onToggle={() => setOpen((value) => !value)}>
          <ol className="flex flex-col" aria-label={`${label} iterations`}>
            {iterations.map((row) => (
              <IterationRow key={row.iteration} step={row} />
            ))}
          </ol>
        </Disclosure>
      ) : (
        step && <StepBody step={step} />
      )}
    </li>
  )
}

function IterationRow({ step }: { step: AutomationStep }): React.JSX.Element {
  return (
    <li className="border-t border-border">
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <span className="min-w-0 flex-1 text-xs tabular-nums text-foreground">
          Item {(step.iteration ?? 0) + 1}
        </span>
        <StepDuration step={step} />
        <StepStatusLabel step={step} loading={false} />
      </div>
      <StepBody step={step} />
    </li>
  )
}

function StepDuration({ step }: { step: AutomationStep | null }): React.JSX.Element | null {
  if (step?.started_at == null || step.finished_at == null) return null
  return (
    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
      {formatDuration(step.finished_at - step.started_at)}
    </span>
  )
}

function StepStatusLabel({
  step,
  loading
}: {
  step: AutomationStep | null
  loading: boolean
}): React.JSX.Element {
  const status = step ? STATUS_PRESENTATION[step.status] : null
  return (
    <>
      {step?.status === 'running' && (
        <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
      )}
      <span className={cn('shrink-0 text-xs', status?.className ?? 'text-muted-foreground')}>
        {status?.label ?? (loading ? '' : 'Not reached')}
      </span>
    </>
  )
}

/** The waiting line, the error and the output toggle of one row. */
function StepBody({ step }: { step: AutomationStep }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasOutput = step.output !== null && step.output !== undefined
  return (
    <>
      <WaitingLine step={step} />
      {step.error && (
        <p className="border-t border-border px-3 py-2 font-mono text-xs break-words text-destructive">
          {step.error}
        </p>
      )}
      {hasOutput && (
        <Disclosure label="Output" open={open} onToggle={() => setOpen((value) => !value)}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-2xs text-secondary-foreground">
            {JSON.stringify(step.output, null, 2)}
          </pre>
        </Disclosure>
      )}
    </>
  )
}

function WaitingLine({ step }: { step: AutomationStep }): React.JSX.Element | null {
  if (step.status !== 'waiting' || step.wait_until === null) return null
  return (
    <p className="border-t border-border px-3 py-2 text-xs text-warning">
      Waiting until {formatDateTime(step.wait_until)}
    </p>
  )
}

function Disclosure({
  label,
  open,
  onToggle,
  children
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-t border-border">
      <button
        type="button"
        className={cn(
          'flex min-h-9 w-full items-center gap-1 px-3 text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11',
          FOCUS_RING_CLASS
        )}
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {open && children}
    </div>
  )
}
