import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BackgroundCommand, ToolCall } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { formatSubagentElapsed, type SubagentStatus, subagentDurationMs } from './subagent-strip'

/**
 * One 1s clock for every running subagent timer on screen. Only the timer
 * leaves subscribe, so a tick re-renders the numbers and not the rows or
 * lists around them. The interval runs only while a timer is mounted.
 */
const listeners = new Set<() => void>()
let now = Date.now()
let interval: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (interval === null) {
    now = Date.now()
    interval = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && interval !== null) {
      clearInterval(interval)
      interval = null
    }
  }
}

const NO_SUBSCRIBE = (): (() => void) => () => {}

/** The shared clock while `ticking`; a fresh read otherwise. */
function useNow(ticking: boolean): number {
  const ticked = useSyncExternalStore(
    ticking ? subscribe : NO_SUBSCRIBE,
    () => (ticking ? now : 0),
    () => 0
  )
  return ticking ? ticked : Date.now()
}

/**
 * When this subagent was seen to settle. Stamped only on an observed running
 * to settled change, so a row loaded from history never shows a made-up time.
 */
function useObservedSettle(status: SubagentStatus): number | undefined {
  const [settledAt, setSettledAt] = useState<number | undefined>(undefined)
  const wasRunning = useRef(status === 'running')
  useEffect(() => {
    const running = status === 'running'
    if (wasRunning.current && !running) setSettledAt((prev) => prev ?? Date.now())
    if (running) setSettledAt(undefined)
    wasRunning.current = running
  }, [status])
  return settledAt
}

const TIME_CLASS = 'shrink-0 text-right text-xs tabular-nums text-muted-foreground'

/** A subagent's elapsed time: ticking while it runs, its total once settled. */
export function SubagentElapsed({
  toolCall,
  status,
  className
}: {
  toolCall: ToolCall
  status: SubagentStatus
  className?: string
}): React.JSX.Element | null {
  const current = useNow(status === 'running')
  const observed = useObservedSettle(status)
  const ms = subagentDurationMs(toolCall, status, current, observed)
  if (ms === undefined) return null
  return <span className={cn(TIME_CLASS, className)}>{formatSubagentElapsed(ms)}</span>
}

/** First start to last end across a group; ticking while any member runs. */
export function SubagentSpanElapsed({
  members,
  className
}: {
  members: readonly { toolCall: ToolCall; status: SubagentStatus }[]
  className?: string
}): React.JSX.Element | null {
  const running = members.some((member) => member.status === 'running')
  const current = useNow(running)
  let start: number | undefined
  let end: number | undefined
  for (const { toolCall, status } of members) {
    const started =
      toolCall.subagent?.startedAt ??
      (typeof toolCall.timestamp === 'number' ? toolCall.timestamp : undefined)
    const duration = subagentDurationMs(toolCall, status, current, undefined)
    if (started === undefined || duration === undefined) continue
    start = start === undefined ? started : Math.min(start, started)
    end = end === undefined ? started + duration : Math.max(end, started + duration)
  }
  if (start === undefined || end === undefined) return null
  return <span className={cn(TIME_CLASS, className)}>{formatSubagentElapsed(end - start)}</span>
}

/** A background command's elapsed time: ticking while it runs, its total once ended. */
export function BackgroundCommandElapsed({
  command,
  className
}: {
  command: BackgroundCommand
  className?: string
}): React.JSX.Element {
  const current = useNow(command.state === 'running')
  const end = command.state === 'ended' ? command.endedAtMs : current
  return (
    <span className={cn(TIME_CLASS, className)}>
      {formatSubagentElapsed(end - command.startedAtMs)}
    </span>
  )
}
