import { useEffect, useRef, useState } from 'react'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import type { TimelineItem } from './chat-timeline'
import { formatTurnDuration } from './format-turn-duration'
import { summarizeToolActivity, type ToolActivitySummary } from './tool-call-summary'

/** One step of agent work between two narration messages. */
export type WorkRunItem = Extract<TimelineItem, { kind: 'tool' } | { kind: 'thought-group' }>

/**
 * One rendered line of a turn's activity, in timeline order. Keys are the
 * timeline item keys (a run takes its first item's), so a renderer's rows keep
 * their identity while the turn streams.
 */
export type TurnActivityEntry =
  /** A contiguous run of tool calls and thoughts, rolled up as one disclosure. */
  | {
      kind: 'work-run'
      key: string
      items: WorkRunItem[]
      summary: ToolActivitySummary
      /** A call in the run failed. */
      failed: boolean
      /** The run owns the turn's last item while the turn is active. */
      isLiveTail: boolean
    }
  /** A thought with no tool call beside it renders bare. */
  | { kind: 'thought'; key: string; messages: ChatMessage[]; isLiveTail: boolean }
  /** Intermediate narration between runs. */
  | { kind: 'message'; key: string; message: ChatMessage; isLast: boolean }

export interface TurnActivityModel {
  entries: TurnActivityEntry[]
  /** Every call in the turn, for the header's aggregate diffstat. */
  summary: ToolActivitySummary | null
}

/**
 * Each contiguous run of thoughts and tool calls becomes one entry, so
 * narration between two runs keeps its seat: work, text, work. A run with no
 * tool call is thoughts only, and those render bare, one entry each.
 */
export function turnActivityModel(items: TimelineItem[], active: boolean): TurnActivityModel {
  const entries: TurnActivityEntry[] = []
  const allCalls: ToolCall[] = []
  const lastItem = items[items.length - 1]
  let run: WorkRunItem[] = []

  const flush = (): void => {
    const calls = run.flatMap((item) => (item.kind === 'tool' ? [item.tool] : []))
    const summary =
      calls.length > 0
        ? summarizeToolActivity(calls, { thoughts: run.length - calls.length })
        : null
    if (summary) {
      entries.push({
        kind: 'work-run',
        key: run[0]!.key,
        items: run,
        summary,
        failed: run.some((member) => member.kind === 'tool' && member.tool.status === 'failed'),
        isLiveTail: active && run[run.length - 1] === lastItem
      })
    } else {
      for (const member of run) {
        if (member.kind === 'thought-group') {
          entries.push({
            kind: 'thought',
            key: member.key,
            messages: member.messages,
            isLiveTail: active && member === lastItem
          })
        }
      }
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'thought-group') {
      if (item.kind === 'tool') allCalls.push(item.tool)
      run.push(item)
      continue
    }
    flush()
    // Switch markers, worktree rows and reload dividers never reach the turn
    // bucket (`groupTurnActivity` emits them top-level).
    if (item.kind === 'message') {
      entries.push({
        kind: 'message',
        key: item.key,
        message: item.message,
        isLast: active && item === lastItem
      })
    }
  }
  flush()

  return { entries, summary: summarizeToolActivity(allCalls) }
}

/** The header line: a live status line, else Working…, else how long the turn took. */
export function turnActivityLabel(
  active: boolean,
  durationMs: number | null,
  statusLine: string | null | undefined
): string {
  if (active && statusLine) return statusLine
  if (active) return 'Working…'
  const duration = formatTurnDuration(durationMs)
  return duration ? `Worked for ${duration}` : 'Worked'
}

/**
 * Open while the turn is active (re-opened whenever it goes active again),
 * closed once it settles with a final response or needs attention, otherwise
 * wherever the reader last put it.
 */
export function useTurnActivityOpen(
  active: boolean,
  attentionRequired: boolean,
  hasFinalResponse: boolean
): [open: boolean, setOpen: React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = useState(active || (!attentionRequired && !hasFinalResponse))
  const wasActive = useRef(active)

  useEffect(() => {
    if (active) {
      setOpen(true)
    } else if (wasActive.current && (hasFinalResponse || attentionRequired)) {
      setOpen(false)
    }
    wasActive.current = active
  }, [active, attentionRequired, hasFinalResponse])

  return [open, setOpen]
}
