import { AlertTriangle } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { needsYouLabel } from '@/lib/agent-chat-attention'
import { cn } from '@/lib/utils'

/**
 * Needs-you pill: 6px warning dot + count. The full label ("3 need you")
 * stays on title/aria-label. #859: the pill never starves the project name —
 * it shows only the count, so its width stays small and fixed.
 */
export function NeedsYouButton({
  count,
  onOpen
}: {
  count: number
  onOpen?: () => void
}): React.JSX.Element | null {
  if (count <= 0) return null
  const label = needsYouLabel(count)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.()
      }}
      className="inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-full bg-warning/10 px-1.5 text-3xs font-semibold tabular-nums text-warning transition-[transform,background-color] duration-150 ease-out hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />
      <span>{count}</span>
    </button>
  )
}

/**
 * Live-work spinner for a project row: 12px, primary (blue is reserved for
 * live work). `label` is the accessible name. An agent that is up but idle
 * gets {@link IdleAgentMark} instead.
 */
export function RunningMark({
  label = 'Running',
  title = 'An agent chat is still running',
  className
}: {
  label?: string
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('flex shrink-0 items-center text-primary', className)} title={title}>
      <Spinner size={12} label={label} />
    </span>
  )
}

/**
 * Idle agent mark: a 6px muted dot for an agent process that is up but not
 * working. No spinner and no blue — those mean live work only.
 */
export function IdleAgentMark({
  label = 'Agent running, idle',
  className
}: {
  label?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title="An agent chat is open and waiting"
      className={cn('flex size-3 shrink-0 items-center justify-center', className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/60" />
    </span>
  )
}

/** Crash mark: 12px triangle + "Crashed" in warning. No pulse. */
export function CrashedMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-2xs text-warning', className)}
      title="Terminal crashed"
    >
      <AlertTriangle size={12} aria-hidden="true" />
      <span>Crashed</span>
    </span>
  )
}

/**
 * Live state of a project row. `activity` = terminal or agent output now
 * (primary spinner). `idle-agent` = an agent process is up but not working
 * (muted dot). Activity wins when both are true.
 */
export type ProjectLiveState = 'activity' | 'idle-agent' | null

/** Everything the right slot of a project row shows, derived once per project. */
export interface ProjectRowStatus {
  live: ProjectLiveState
  attentionCount: number
  crashed: boolean
}

export function resolveProjectLiveState(hasActivity: boolean, running: boolean): ProjectLiveState {
  if (hasActivity) return 'activity'
  return running ? 'idle-agent' : null
}

const LIVE_MARK: Record<NonNullable<ProjectLiveState>, React.JSX.Element> = {
  activity: <RunningMark label="Project activity" title="Activity" />,
  'idle-agent': <IdleAgentMark />
}

/** Project row right slot, fixed order so nothing shifts: live work → needs you → crash. */
export function ProjectStatusMarks({
  status,
  onOpenNeedsYou
}: {
  status: ProjectRowStatus
  onOpenNeedsYou: () => void
}): React.JSX.Element {
  return (
    <>
      {status.live && LIVE_MARK[status.live]}
      <NeedsYouButton count={status.attentionCount} onOpen={onOpenNeedsYou} />
      {status.crashed && <CrashedMark />}
    </>
  )
}
