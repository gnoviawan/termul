import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, FolderGit2, XCircle } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'

type StepState = 'pending' | 'active' | 'done' | 'error'

function StepIcon({ state }: { state: StepState }): React.JSX.Element {
  if (state === 'active') return <Spinner className="size-3.5 text-muted-foreground" />
  if (state === 'done') return <Check size={14} className="text-success" />
  if (state === 'error') return <XCircle size={14} className="text-destructive" />
  return <span className="inline-block size-3.5 rounded-full border border-muted-foreground/30" />
}

function StepRow({
  label,
  detail,
  state
}: {
  label: string
  detail?: string
  state: StepState
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-xs',
        state === 'pending' ? 'text-muted-foreground/60' : 'text-muted-foreground'
      )}
    >
      <StepIcon state={state} />
      <span>
        {label}
        {detail ? <span className="tabular-nums"> {detail}</span> : null}
      </span>
    </div>
  )
}

interface WorktreeCreationCardProps {
  progressId: string
}

/**
 * In-timeline progress card for `git worktree add` during a chat launch.
 * Step state derives from the streamed git stderr lines held in
 * `useWorktreeProgressStore` (`Preparing worktree…` → step 1,
 * `Updating files: N%` → step 2 percent). The detail log is collapsible and
 * auto-scrolls while the op is running unless the reader scrolls away.
 */
export function WorktreeCreationCard({ progressId }: WorktreeCreationCardProps): React.JSX.Element {
  const op = useWorktreeProgressStore((s) => s.ops[progressId])
  const [logOpen, setLogOpen] = useState(true)
  const logRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  const running = !op || op.status === 'preparing' || op.status === 'running'

  // Follow the live edge while running unless the reader scrolled away.
  useEffect(() => {
    const el = logRef.current
    if (!el || !logOpen || !running) return
    if (pinnedRef.current && op && op.lines.length > 0) el.scrollTop = el.scrollHeight
  }, [op, logOpen, running])

  const handleLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
  }

  const lines = op?.lines ?? []
  const checkoutStarted =
    op != null &&
    (op.percent !== null ||
      lines.some((l) => l.startsWith('Updating files:') || l.startsWith('HEAD is now at')))
  const prepareDone = checkoutStarted || op?.status === 'done'
  const copying = lines.some((l) => l.startsWith('Copying .worktree-include'))
  const failed = op?.status === 'error'

  const step = (active: boolean, done: boolean): StepState =>
    failed ? (done ? 'done' : 'error') : done ? 'done' : active ? 'active' : 'pending'

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium">
        <FolderGit2 size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          Creating a worktree
          {op?.branch ? (
            <span className="font-normal text-muted-foreground"> · {op.branch}</span>
          ) : null}
        </span>
        {running ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        <StepRow label="Preparing workspace" state={step(running && !prepareDone, prepareDone)} />
        <StepRow
          label="Checking out files"
          detail={op?.percent != null ? `${op.percent}%` : undefined}
          state={step(checkoutStarted && running, op?.status === 'done')}
        />
        {copying ? (
          <StepRow label="Copying include files" state={step(running, op?.status === 'done')} />
        ) : null}
      </div>

      {failed && op?.error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {op.error}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <Collapsible open={logOpen} onOpenChange={setLogOpen} className="mt-2">
          <CollapsibleTrigger
            data-press-feedback="off"
            className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight
              size={12}
              className={cn('shrink-0 transition-transform', logOpen && 'rotate-90')}
            />
            <span>{logOpen ? 'Hide log' : 'Show log'}</span>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount>
            <CollapseExpandMotion open={logOpen}>
              <div
                ref={logRef}
                onScroll={handleLogScroll}
                className="scroller-thin mt-1.5 max-h-[160px] overflow-y-auto rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {op && op.dropped > 0 ? (
                  <div>
                    … {op.dropped} earlier line{op.dropped === 1 ? '' : 's'}
                  </div>
                ) : null}
                {lines.map((line, i) => (
                  <div key={`${i}-${line.length}`} className="whitespace-pre-wrap break-all">
                    {line}
                  </div>
                ))}
              </div>
            </CollapseExpandMotion>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}
