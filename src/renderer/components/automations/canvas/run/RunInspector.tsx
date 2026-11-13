import type { AutomationNode, AutomationRun, AutomationStep } from '@shared/types/automation.types'
import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { parseApprovalOutput } from '@/lib/automation-wire'
import { copyTextWithToast } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import {
  DECISION_PRESENTATION,
  firedPresentation,
  formatDateTime,
  formatDuration,
  NODE_KIND_PRESENTATION,
  TRIGGER_LABEL
} from '../../automation-format'
import { InspectorPanel } from '../inspector/NodeInspector'
import type { LoopRun, RunOverlay, StepView } from './run-overlay'
import { STEP_VIEW, StepGlyph } from './step-view'

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

function StatusBadge({ status }: { status: StepView }): React.JSX.Element {
  return (
    <span
      data-testid="inspector-status"
      className={cn(
        'flex shrink-0 items-center gap-1 text-xs font-medium',
        STEP_VIEW[status].className
      )}
    >
      <StepGlyph status={status} size={14} />
      {STEP_VIEW[status].label}
    </span>
  )
}

/**
 * The inspector of a run: the step's status in the header, the iteration
 * picker for a for_each or a step in its body, timing, the approval's
 * decide actions while the run is parked on it, the error, and the output.
 * Read-only otherwise. `node` null inspects the trigger.
 */
export function RunInspector({
  run,
  node,
  overlay,
  phone,
  approval,
  onPick,
  onClose
}: {
  run: AutomationRun
  node: AutomationNode | null
  overlay: RunOverlay
  phone: boolean
  /** The decide card, when the run is parked on this step in the iteration shown. */
  approval: React.ReactNode
  onPick: (loopId: string, iteration: number) => void
  onClose: () => void
}): React.JSX.Element {
  if (node === null) {
    const fired = firedPresentation({ by: run.trigger, at: run.scheduled_for })
    return (
      <InspectorPanel
        phone={phone}
        Icon={fired.Icon}
        title={fired.title}
        kind="Trigger"
        id="trigger"
        status={<StatusBadge status={overlay.cards.get('trigger')?.status ?? 'succeeded'} />}
        onClose={onClose}
      >
        <Facts
          rows={[
            ['Trigger', TRIGGER_LABEL[run.trigger]],
            ['Due', formatDateTime(run.scheduled_for)],
            ['Started', formatDateTime(run.started_at)]
          ]}
        />
      </InspectorPanel>
    )
  }

  const { label, Icon } = NODE_KIND_PRESENTATION[node.spec.kind]
  const status = overlay.cards.get(node.id)?.status ?? 'pending'
  const row = overlay.rows.get(node.id) ?? null
  const loopId = node.spec.kind === 'for_each' ? node.id : overlay.loopOf.get(node.id)
  const loop = loopId === undefined ? undefined : overlay.loops.get(loopId)
  return (
    <InspectorPanel
      phone={phone}
      Icon={Icon}
      title={node.label}
      kind={label}
      id={node.id}
      status={<StatusBadge status={status} />}
      onClose={onClose}
    >
      {loopId !== undefined && loop && (
        <IterationPicker
          loop={loop}
          inBody={loopId !== node.id}
          onPick={(iteration) => onPick(loopId, iteration)}
        />
      )}
      {approval}
      {row ? (
        <StepFacts step={row} kind={node.spec.kind} />
      ) : (
        <p className="text-xs text-muted-foreground">This step has not run yet.</p>
      )}
    </InspectorPanel>
  )
}

/** One toggle per iteration, its status glyph beside its number. */
function IterationPicker({
  loop,
  inBody,
  onPick
}: {
  loop: LoopRun
  inBody: boolean
  onPick: (iteration: number) => void
}): React.JSX.Element {
  const { iterations, picked } = loop
  if (picked === null) {
    return <p className="text-xs text-muted-foreground">No iteration has run.</p>
  }
  return (
    <section aria-label="Iteration" className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">Iteration</span>
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border p-1">
        {iterations.map((view, index) => (
          <Button
            // Iterations only grow; the index is stable.
            key={index}
            variant="ghost"
            size="xs"
            aria-pressed={index === picked}
            aria-label={`Iteration ${index + 1}, ${STEP_VIEW[view].label}`}
            className={cn(
              'shrink-0 gap-1 tabular-nums pointer-coarse:h-11',
              index === picked && 'keycap text-foreground'
            )}
            onClick={() => onPick(index)}
          >
            <StepGlyph status={view} size={12} />
            {index + 1}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Iteration {picked + 1} of {iterations.length}: {STEP_VIEW[iterations[picked]].label}.
        {inBody ? '' : ' The steps in the loop show this iteration.'}
      </p>
    </section>
  )
}

function Facts({ rows }: { rows: [string, string][] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="text-right tabular-nums text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Timing, an approval's decision, the error and the output of one step row. */
function StepFacts({
  step,
  kind
}: {
  step: AutomationStep
  kind: AutomationNode['spec']['kind']
}): React.JSX.Element {
  const facts: [string, string][] = []
  if (step.started_at !== null) facts.push(['Started', CLOCK.format(step.started_at)])
  if (step.started_at !== null && step.finished_at !== null) {
    facts.push(['Duration', formatDuration(step.finished_at - step.started_at)])
  }
  if (step.status === 'waiting' && step.wait_until !== null) {
    facts.push([
      kind === 'approval' ? 'Waiting for approval until' : 'Waiting until',
      formatDateTime(step.wait_until)
    ])
  }
  const approval = kind === 'approval' ? parseApprovalOutput(step.output) : null
  const decision = approval?.decision === undefined ? null : approval
  const hasOutput = step.output !== null && step.output !== undefined
  return (
    <>
      {facts.length > 0 && <Facts rows={facts} />}
      {decision && (
        <p className="text-xs tabular-nums">
          <span className={DECISION_PRESENTATION[decision.decision].className}>
            {DECISION_PRESENTATION[decision.decision].label}
          </span>
          <span className="text-muted-foreground"> · {formatDateTime(decision.decided_at)}</span>
        </p>
      )}
      {step.error && !decision && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 font-mono text-xs break-words text-destructive">
          {step.error}
        </p>
      )}
      {hasOutput && <Output value={step.output} />}
    </>
  )
}

/** The output as text, JSON pretty-printed; folds away and copies. */
function Output({ value }: { value: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <section aria-label="Output" className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <button
          type="button"
          className={cn(
            'flex min-h-7 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground pointer-coarse:min-h-11',
            FOCUS_RING_CLASS
          )}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Output
        </button>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto pointer-coarse:h-11"
          onClick={() =>
            void copyTextWithToast(text, {
              title: 'Output copied',
              failureTitle: 'Could not copy the output',
              logSource: 'automation-run:copy-output'
            })
          }
        >
          <Copy size={12} />
          Copy
        </Button>
      </div>
      {open && (
        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-2xs whitespace-pre-wrap break-words text-secondary-foreground">
          {text}
        </pre>
      )}
    </section>
  )
}
