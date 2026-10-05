import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, FolderGit2, XCircle } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { CHEVRON_TRANSITION } from './chat-motion'

/**
 * Per-op disclosure state that survives virtualizer unmounts — the chat list
 * windows rows, so a user-collapsed row would otherwise re-expand on
 * scroll-back. Keyed by progressId; an absent entry means "open" (default).
 */
const openByProgressId = new Map<string, boolean>()

type StepState = 'pending' | 'active' | 'done' | 'error'

function StepIcon({ state }: { state: StepState }): React.JSX.Element {
  if (state === 'active') return <Spinner size={14} decorative className="text-muted-foreground" />
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
 * In-timeline progress row for `git worktree add` during a chat launch.
 * Renders like a tool-call row (icon + title + trailing detail + rotating
 * chevron); the expanded detail lists the creation steps and the streamed
 * git log. Step state derives from the streamed git stderr lines held in
 * `useWorktreeProgressStore` (`Preparing worktree…` → step 1,
 * `Updating files: N%` → step 2 percent). The detail log auto-scrolls while
 * the op is running unless the reader scrolls away.
 */
export function WorktreeCreationCard({ progressId }: WorktreeCreationCardProps): React.JSX.Element {
  const op = useWorktreeProgressStore((s) => s.ops[progressId])
  const reduced = useReducedMotion() ?? false
  const detailId = useId()
  // Open by default in every state — running, done, and error; toggled only
  // by user clicks (no auto-collapse on completion). The flag is mirrored
  // into `openByProgressId` so a virtualizer unmount/remount keeps the
  // user's choice instead of resetting to open.
  const [open, setOpen] = useState(() => openByProgressId.get(progressId) ?? true)
  const logRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  const running = !op || op.status === 'preparing' || op.status === 'running'
  const failed = op?.status === 'error'

  // Follow the live edge while running unless the reader scrolled away.
  useEffect(() => {
    const el = logRef.current
    if (!el || !open || !running) return
    if (pinnedRef.current && op && op.lines.length > 0) el.scrollTop = el.scrollHeight
  }, [op, open, running])

  const handleLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48
  }

  const toggleOpen = (): void => {
    const next = !open
    openByProgressId.set(progressId, next)
    setOpen(next)
  }

  const lines = op?.lines ?? []
  const checkoutStarted =
    op != null &&
    (op.percent !== null ||
      lines.some((l) => l.startsWith('Updating files:') || l.startsWith('HEAD is now at')))
  const prepareDone = checkoutStarted || op?.status === 'done'
  const copying = lines.some((l) => l.startsWith('Copying .worktree-include'))

  const step = (active: boolean, done: boolean): StepState =>
    failed ? (done ? 'done' : 'error') : done ? 'done' : active ? 'active' : 'pending'

  const title = op?.status === 'done' ? 'Worktree created..' : 'Creating worktree..'
  const trailingDetail = [op?.branch, running && op?.percent != null ? `${op.percent}%` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      aria-busy={running || undefined}
      data-status={op?.status}
      className="relative w-full overflow-hidden"
    >
      <div>
        <div className={cn('flex items-center gap-2 px-1 text-xs', CHAT_ROW_MIN_H)}>
          <button
            type="button"
            onClick={toggleOpen}
            aria-expanded={open}
            aria-controls={detailId}
            data-press-feedback="off"
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              CHAT_ROW_MIN_H
            )}
          >
            <FolderGit2
              size={13}
              className={cn('shrink-0', failed ? 'text-destructive' : 'text-muted-foreground')}
            />
            <span className="min-w-0 flex-1 truncate" title={title}>
              {running ? (
                <ShimmerText text={title} className="block truncate" />
              ) : (
                <span
                  className={cn('font-medium', failed ? 'text-destructive' : 'text-foreground')}
                >
                  {title}
                </span>
              )}
            </span>
            {trailingDetail ? (
              <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                {trailingDetail}
              </span>
            ) : null}
          </button>
          {failed && <AlertCircle size={12} className="shrink-0 text-destructive" />}
          <motion.span
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
            animate={{ rotate: open ? 90 : 0 }}
            transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
          >
            <ChevronRight size={13} />
          </motion.span>
        </div>
        <CollapseExpandMotion open={open} motion="chat">
          <div
            id={detailId}
            className="ml-4 flex flex-col gap-1.5 border-l border-border/50 px-2 pb-2 pt-1.5"
          >
            <StepRow
              label="Preparing workspace"
              state={step(running && !prepareDone, prepareDone)}
            />
            <StepRow
              label="Checking out files"
              detail={op?.percent != null ? `${op.percent}%` : undefined}
              state={step(checkoutStarted && running, op?.status === 'done')}
            />
            {copying ? (
              <StepRow label="Copying include files" state={step(running, op?.status === 'done')} />
            ) : null}
            {failed && op?.error ? (
              <p className="text-xs text-destructive" role="alert">
                {op.error}
              </p>
            ) : null}
            {lines.length > 0 ? (
              <div
                ref={logRef}
                onScroll={handleLogScroll}
                className="scroller-thin max-h-[160px] overflow-y-auto rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
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
            ) : null}
          </div>
        </CollapseExpandMotion>
      </div>
    </div>
  )
}
