import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, LoaderCircle, XCircle } from '@/components/icons'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'
import {
  formatElapsed,
  formatTokens,
  isBackgroundSubagent,
  type SubagentCounts,
  type SubagentStatus,
  subagentChildCalls,
  subagentDurationMs,
  subagentMetrics,
  subagentStatus,
  subagentTitle,
  subagentType
} from './subagent-strip'

const STATUS_LABEL: Record<SubagentStatus, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

const COUNT_KEYS = ['running', 'done', 'failed'] as const

const COUNT_TONE: Record<(typeof COUNT_KEYS)[number], string> = {
  running: 'text-warning',
  done: 'text-success',
  failed: 'text-destructive'
}

/** Solid spinning arc in the running tone, per the approved mockup. */
export function RunningIcon(): React.JSX.Element {
  return (
    <LoaderCircle
      size={13}
      strokeWidth={2}
      className="shrink-0 animate-spin text-warning motion-reduce:animate-none"
      aria-hidden="true"
    />
  )
}

function StatusIcon({ status }: { status: SubagentStatus }): React.JSX.Element {
  if (status === 'running') return <RunningIcon />
  if (status === 'failed') {
    return <XCircle size={13} className="shrink-0 text-destructive" aria-hidden="true" />
  }
  if (status === 'stopped') {
    return <XCircle size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return <CheckCircle2 size={13} className="shrink-0 text-success" aria-hidden="true" />
}

/** "1 running, 2 done": the non-zero counts, for accessible names. */
export function subagentCountSummary(counts: SubagentCounts): string {
  return COUNT_KEYS.filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${STATUS_LABEL[key]}`)
    .join(', ')
}

/** The non-zero counts in their status tones, dot separated. */
export function SubagentCountParts({ counts }: { counts: SubagentCounts }): React.JSX.Element {
  return (
    <>
      {COUNT_KEYS.filter((key) => counts[key] > 0).map((key, i) => (
        <span key={key} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
          )}
          <span className={COUNT_TONE[key]}>
            {counts[key]} {STATUS_LABEL[key]}
          </span>
        </span>
      ))}
    </>
  )
}

/**
 * One row per subagent. Running rows tick their elapsed time while the list
 * is mounted; resuming re-reads the clock, so elapsed jumps to the right value.
 */
export function SubagentRows({
  subagents,
  turnActive,
  endedAt,
  running,
  onSelect,
  className
}: {
  subagents: readonly ToolCall[]
  turnActive: boolean
  endedAt: Readonly<Record<string, number>>
  /** Count of running rows: one interval drives them all, only while non-zero. */
  running: number
  onSelect: (toolCallId: string) => void
  className?: string
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const ticking = running > 0
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  return (
    <ul
      className={cn(
        'scroller-thin flex max-h-72 flex-col overflow-y-auto overscroll-contain',
        className
      )}
    >
      {subagents.map((tc) => {
        const status = subagentStatus(tc, turnActive)
        const type = subagentType(tc)
        const metrics = subagentMetrics(tc)
        const durationMs = subagentDurationMs(tc, status, now, endedAt[tc.toolCallId])
        return (
          <li key={tc.toolCallId}>
            <button
              type="button"
              onClick={() => onSelect(tc.toolCallId)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                CHAT_ROW_MIN_H
              )}
            >
              <span className="inline-flex shrink-0" aria-hidden="true">
                <StatusIcon status={status} />
              </span>
              <span className="sr-only">{STATUS_LABEL[status]}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {subagentTitle(tc)}
                {type && <span className="ml-1.5 text-muted-foreground">{type}</span>}
              </span>
              {isBackgroundSubagent(tc) && (
                <span className="shrink-0 rounded-sm border border-border px-1 text-2xs text-muted-foreground">
                  background
                </span>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {durationMs !== undefined && formatElapsed(durationMs)}
                {status !== 'running' && metrics.totalTokens !== undefined && (
                  <span className="ml-1.5">{formatTokens(metrics.totalTokens)}</span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Details dialog for the selected subagent. Keeps the last resolved call so
 * the dialog can close itself normally when its call leaves the current turn
 * (the live object wins while listed).
 */
export function SubagentDetails({
  toolCalls,
  subagents,
  selectedId,
  turnActive,
  filePathContext,
  onClose
}: {
  toolCalls: readonly ToolCall[]
  subagents: readonly ToolCall[]
  selectedId: string | null
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  onClose: () => void
}): React.JSX.Element | null {
  const lastSelected = useRef<ToolCall | null>(null)
  const live = selectedId ? subagents.find((tc) => tc.toolCallId === selectedId) : undefined
  useEffect(() => {
    if (live) lastSelected.current = live
  }, [live])
  const selected = selectedId ? (live ?? lastSelected.current) : null
  const childCalls = useMemo(
    () => (selectedId ? subagentChildCalls(toolCalls, selectedId) : []),
    [toolCalls, selectedId]
  )
  if (!selected) return null
  return (
    <SubagentDetailsDialog
      toolCall={selected}
      childToolCalls={childCalls}
      parentTurn={turnActive ? 'active' : 'ended'}
      filePathContext={filePathContext}
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    />
  )
}
