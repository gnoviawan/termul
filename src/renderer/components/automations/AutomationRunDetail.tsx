import type {
  Automation,
  AutomationNode,
  AutomationRun,
  AutomationStep
} from '@shared/types/automation.types'
import { useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { WriteGate } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cancelAutomationRun } from '@/lib/automation-api'
import { parseApprovalOutput } from '@/lib/automation-wire'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { AutomationApprovalCard } from './AutomationApprovalCard'
import {
  formatDateTime,
  formatDuration,
  NODE_KIND_PRESENTATION,
  type ParkedApproval,
  parkedApproval,
  runStatusPresentation,
  TRIGGER_LABEL
} from './automation-format'
import { AutomationFlow } from './canvas/flow/AutomationFlow'
import { INSPECTOR_INSET } from './canvas/inspector/NodeInspector'
import { stepOrder } from './canvas/layout'
import { TRIGGER } from './canvas/ports'
import { RunInspector } from './canvas/run/RunInspector'
import { openingStep, type RunOverlay, runOverlay, type StepView } from './canvas/run/run-overlay'
import { STEP_VIEW, StepGlyph } from './canvas/run/step-view'
import { useRunSteps } from './use-automations'

/**
 * The trigger card names what started the run (`RunMarks.fired`), so the
 * automation's trigger settings, which may have changed since, are not drawn.
 */
const RUN_TRIGGER: Automation['trigger'] = { kind: 'manual' }

const parkKey = (approval: ParkedApproval | null): string | null =>
  approval && `${approval.node.id}:${approval.iteration ?? ''}`

/**
 * One run on its own graph, filling the pane: the header (status, when,
 * Cancel), the canvas with each step's status, and the steps as a list
 * that opens the inspector. Statuses follow the run live through
 * `useRunSteps`. A run parked on an approval opens on that step, with the
 * decide actions in the inspector.
 */
export function AutomationRunDetail({
  run,
  automation,
  phone,
  onClose,
  onChanged
}: {
  run: AutomationRun
  /** Where the cards sit; null while it loads. */
  automation: Pick<Automation, 'layout'> | null
  phone: boolean
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const { data: steps, error, reload } = useRunSteps(run)
  const [cancelling, setCancelling] = useState(false)
  const gated = !useServerAdmitsRemoteWrites()
  const approval = parkedApproval(run)
  const [picks, setPicks] = useState<Record<string, number>>({})
  const [inspected, setInspected] = useState<string | null>(approval?.node.id ?? null)
  // A step opened from the list or by a park is selected and centred on the canvas.
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(
    approval ? { id: approval.node.id, nonce: 0 } : null
  )
  const show = (id: string): void => {
    setInspected(id)
    setFocus({ id, nonce: Date.now() })
  }
  // A park that begins while the run is open brings its step, in its iteration, into view.
  const [park, setPark] = useState(parkKey(approval))
  const overlay = useMemo(() => runOverlay(run, steps ?? [], picks), [run, steps, picks])
  if (park !== parkKey(approval)) {
    setPark(parkKey(approval))
    if (approval) {
      show(approval.node.id)
      const loop = overlay.loopOf.get(approval.node.id)
      if (loop && approval.iteration !== null) {
        setPicks((prev) => ({ ...prev, [loop]: approval.iteration as number }))
      }
    }
  }
  const layout = automation?.layout
  const shown = useMemo(
    () => ({ graph: run.graph, trigger: RUN_TRIGGER, layout: layout ?? {} }),
    [run.graph, layout]
  )
  const status = runStatusPresentation(run)
  const cancel = async (): Promise<void> => {
    setCancelling(true)
    await cancelAutomationRun(run.id)
    setCancelling(false)
  }
  const pick = (loopId: string, iteration: number): void =>
    setPicks((prev) => ({ ...prev, [loopId]: iteration }))

  const order = useMemo(() => stepOrder(run.graph), [run.graph])
  // Run mode from the first render, steps or not: until they load (or if they fail) the
  // cards carry no status, but the canvas still owns its gestures and names the trigger.
  const marks = useMemo(
    () => (steps === null ? { fired: overlay.fired, cards: new Map(), edges: new Map() } : overlay),
    [steps, overlay]
  )
  const node = run.graph.nodes.find((candidate) => candidate.id === inspected) ?? null
  const loopOfNode = node && overlay.loopOf.get(node.id)
  // Outside a loop the decide card always shows; inside one, in the iteration that waits.
  const parkedHere =
    approval !== null &&
    node?.id === approval.node.id &&
    (!loopOfNode || overlay.loops.get(loopOfNode)?.picked === approval.iteration)
  const inspector =
    inspected === TRIGGER || node ? (
      <RunInspector
        // Another step starts with its output unfolded.
        key={inspected}
        run={run}
        node={node}
        overlay={overlay}
        phone={phone}
        onPick={pick}
        onClose={() => setInspected(null)}
        approval={
          parkedHere && (
            <AutomationApprovalCard
              key={`${run.id}:${approval.node.id}:${approval.iteration}`}
              runId={run.id}
              nodeId={approval.node.id}
              label={approval.node.label}
              until={approval.until}
              message={approvalMessage(approval, steps)}
              messageFailed={steps === null && error !== null}
              onRetry={reload}
              onDecided={() => {
                reload()
                onChanged()
              }}
            />
          )
        }
      />
    ) : null

  const notes = [
    gated && run.status === 'running' && (
      <p key="gated" className="text-muted-foreground">
        {READ_ONLY_SERVER_REASON}
      </p>
    ),
    run.stop_reason && (
      <p key="stop" className="break-words text-destructive">
        {run.stop_reason}
      </p>
    ),
    run.summary && (
      <p key="summary" className="text-foreground">
        {run.summary}
      </p>
    ),
    error && (
      <p key="error" className="flex flex-wrap items-center gap-x-2 text-destructive">
        Could not load the steps: {error}
        <Button variant="outline" size="xs" className="pointer-coarse:h-11" onClick={reload}>
          Try again
        </Button>
      </p>
    )
  ].filter(Boolean)

  return (
    <div data-testid="automation-run" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button
          variant="ghost"
          size={phone ? 'touch' : 'icon-sm'}
          className={phone ? 'w-11' : undefined}
          aria-label="Back to the automation"
          title="Back to the automation"
          onClick={onClose}
        >
          <ArrowLeft size={16} />
        </Button>
        <div className={cn('flex min-w-0 flex-1', phone ? 'flex-col' : 'items-center gap-3')}>
          <h3 className={cn('shrink-0 text-sm font-medium', status.className)}>{status.label}</h3>
          <span className="truncate text-xs tabular-nums text-muted-foreground">
            {TRIGGER_LABEL[run.trigger]} · {formatDateTime(run.started_at)}
            {run.finished_at !== null &&
              ` · took ${formatDuration(run.finished_at - run.started_at)}`}
            {` · revision ${run.revision}`}
          </span>
        </div>
        {run.status === 'running' && (
          <WriteGate gated={gated} className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={gated || cancelling}
              onClick={() => void cancel()}
            >
              Cancel run
            </Button>
          </WriteGate>
        )}
      </header>
      {notes.length > 0 && (
        <div className="flex max-h-24 shrink-0 flex-col gap-1 overflow-y-auto border-b border-border px-4 py-2 text-xs">
          {notes}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <AutomationFlow
          automation={shown}
          phone={phone}
          run={marks}
          focus={focus}
          openOn={steps === null ? null : openingStep(overlay, order)}
          inspect={{ id: inspected, onChange: setInspected }}
          rightInset={inspector && !phone ? INSPECTOR_INSET : 0}
        />
        {!phone && inspector}
      </div>

      {/* The phone sheet takes the step list's place. */}
      {phone && inspector ? (
        inspector
      ) : (
        <StepList
          nodes={order}
          steps={steps}
          overlay={overlay}
          inspected={inspected}
          phone={phone}
          onInspect={show}
        />
      )}
    </div>
  )
}

/** The parked step's rendered message: `null` while the steps load, empty if it has none. */
function approvalMessage(approval: ParkedApproval, steps: AutomationStep[] | null): string | null {
  if (steps === null) return null
  const step = steps.find(
    (row) => row.node_id === approval.node.id && row.iteration === approval.iteration
  )
  return parseApprovalOutput(step?.output)?.message ?? ''
}

/**
 * The run's steps in the order they first run, each with its status, its
 * iterations and its duration. A row opens the step in the inspector; for
 * keyboards and screen readers it is the way into the canvas.
 */
function StepList({
  nodes,
  steps,
  overlay,
  inspected,
  phone,
  onInspect
}: {
  nodes: readonly AutomationNode[]
  steps: AutomationStep[] | null
  overlay: RunOverlay
  inspected: string | null
  phone: boolean
  onInspect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <section
      aria-label="Steps"
      className="flex max-h-[40%] shrink-0 flex-col border-t border-border"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <span className="px-2 text-xs font-medium text-muted-foreground">Steps</span>
        <Button
          variant="ghost"
          size={phone ? 'touch' : 'icon-sm'}
          className={cn('ml-auto', phone && 'w-11')}
          aria-label={open ? 'Collapse the steps' : 'Expand the steps'}
          aria-expanded={open}
          aria-controls="automation-run-steps"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </Button>
      </div>
      {open && (
        <ol
          id="automation-run-steps"
          aria-label="Steps"
          className="flex min-h-0 flex-col overflow-y-auto px-2 pb-2"
        >
          <StepRow
            title={TRIGGER_LABEL[overlay.fired.by]}
            kind="Trigger"
            status={overlay.cards.get(TRIGGER)?.status ?? 'succeeded'}
            loading={false}
            selected={inspected === TRIGGER}
            onClick={() => onInspect(TRIGGER)}
          />
          {nodes.map((node) => (
            <StepRow
              key={node.id}
              title={node.label}
              kind={NODE_KIND_PRESENTATION[node.spec.kind].label}
              status={overlay.cards.get(node.id)?.status ?? 'pending'}
              loading={steps === null}
              detail={rowDetail(node, overlay, steps ?? [])}
              selected={inspected === node.id}
              onClick={() => onInspect(node.id)}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

/** What a row says beside its status: iterations, or how long it took. */
function rowDetail(
  node: AutomationNode,
  overlay: RunOverlay,
  steps: AutomationStep[]
): { chip?: string; spoken?: string; duration?: string } {
  const loop = overlay.loops.get(node.id)
  if (loop) {
    const count = loop.iterations.length
    const failed = loop.failed > 0 ? ` · ${loop.failed} failed` : ''
    const text = `${count} ${count === 1 ? 'iteration' : 'iterations'}${failed}`
    return { chip: text, spoken: text }
  }
  const row = overlay.rows.get(node.id)
  const duration =
    row?.started_at != null && row.finished_at != null
      ? formatDuration(row.finished_at - row.started_at)
      : undefined
  const loopId = overlay.loopOf.get(node.id)
  const picked = loopId === undefined ? null : (overlay.loops.get(loopId)?.picked ?? null)
  if (loopId === undefined || picked === null) return { duration }
  const count = overlay.loops.get(loopId)?.iterations.length ?? 0
  const ran = steps.filter(
    (step) => step.node_id === node.id && step.iteration !== null && step.status !== 'skipped'
  ).length
  return {
    chip: `${ran}/${count}`,
    spoken: `iteration ${picked + 1}, ran in ${ran} of ${count} iterations`,
    duration
  }
}

function StepRow({
  title,
  kind,
  status,
  loading,
  detail = {},
  selected,
  onClick
}: {
  title: string
  kind: string
  status: StepView
  loading: boolean
  detail?: { chip?: string; spoken?: string; duration?: string }
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const label = loading ? null : STEP_VIEW[status].label
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={[title, kind, detail.spoken, label, detail.duration].filter(Boolean).join(', ')}
        onClick={onClick}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-foreground/[0.03] pointer-coarse:min-h-11',
          selected && 'bg-muted',
          FOCUS_RING_CLASS
        )}
      >
        {loading ? <span className="size-4 shrink-0" /> : <StepGlyph status={status} />}
        <span className="min-w-0 truncate text-sm text-foreground">{title}</span>
        <span className="shrink-0 text-muted-foreground">{kind}</span>
        {detail.chip && (
          <span className="shrink-0 rounded-full border border-border px-1.5 font-medium leading-5 tabular-nums text-foreground">
            {detail.chip}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {detail.duration}
        </span>
      </button>
    </li>
  )
}
