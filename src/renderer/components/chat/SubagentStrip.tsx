import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, ChevronDown, XCircle } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store/types'
import { CollapseExpandMotion } from '../ui/collapse-expand-motion'
import { CHAT_GUTTER_X, CHAT_HIT_MIN_H, CHAT_ROW_MIN_H } from './chat-layout'
import { CHAT_SPRING_SOFT } from './chat-motion'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'
import {
  countSubagents,
  formatElapsed,
  formatTokens,
  type SubagentStatus,
  selectCurrentTurnSubagents,
  subagentMetrics,
  subagentStatus,
  subagentTitle,
  subagentType
} from './subagent-strip'
import { useForcedCollapse } from './use-forced-collapse'

interface SubagentStripProps {
  toolCalls: readonly ToolCall[]
  messages: readonly ChatMessage[]
  /** Session `activeTurn`: a subagent with no status yet counts as running while true. */
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  /** Render collapsed while true (the mobile dock). */
  forceCollapsed?: boolean
  /** False while the chat tab is hidden (tabs stay mounted); pauses the timer. */
  isVisible?: boolean
}

const STATUS_LABEL: Record<SubagentStatus, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

function StatusIcon({ status }: { status: SubagentStatus }): React.JSX.Element {
  if (status === 'running') return <Spinner size={13} decorative className="text-warning" />
  if (status === 'failed') {
    return <XCircle size={13} className="shrink-0 text-destructive" aria-hidden="true" />
  }
  if (status === 'stopped') {
    return <XCircle size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return <CheckCircle2 size={13} className="shrink-0 text-success" aria-hidden="true" />
}

function lastUserBoundary(messages: readonly ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return null
}

/**
 * Collapsible strip above the composer listing the current turn's subagents
 * with live status, elapsed time, and tokens. Renders nothing without any.
 */
export function SubagentStrip({
  toolCalls,
  messages,
  turnActive,
  filePathContext,
  forceCollapsed = false,
  isVisible = true
}: SubagentStripProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const { collapsed, toggle } = useForcedCollapse(false, forceCollapsed)
  const bodyId = useId()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const lastUser = lastUserBoundary(messages)
  const lastUserSeq = lastUser?.seq
  const lastUserTimestamp = lastUser?.timestamp
  const hasUser = lastUser !== null
  const subagents = useMemo(
    () =>
      selectCurrentTurnSubagents(
        toolCalls,
        hasUser ? { seq: lastUserSeq, timestamp: lastUserTimestamp } : null
      ),
    [toolCalls, hasUser, lastUserSeq, lastUserTimestamp]
  )
  const counts = countSubagents(subagents, turnActive)

  // One interval for every running row; cleared when none is running, the
  // list is collapsed, or the chat tab is hidden. Resuming re-reads the clock,
  // so elapsed jumps to the right value.
  const [now, setNow] = useState(() => Date.now())
  const ticking = counts.running > 0 && !collapsed && isVisible
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  // Settle time is stamped only on an observed running -> settled transition,
  // so history-loaded rows never show a bogus duration.
  const [endedAt, setEndedAt] = useState<Record<string, number>>({})
  const prevRunning = useRef(new Map<string, boolean>())
  useEffect(() => {
    const settled: string[] = []
    for (const tc of subagents) {
      const running = subagentStatus(tc, turnActive) === 'running'
      if (prevRunning.current.get(tc.toolCallId) === true && !running) settled.push(tc.toolCallId)
      prevRunning.current.set(tc.toolCallId, running)
    }
    if (settled.length === 0) return
    const stamp = Date.now()
    setEndedAt((prev) => {
      const next = { ...prev }
      for (const id of settled) next[id] ??= stamp
      return next
    })
  }, [subagents, turnActive])

  // Keep the last resolved call so the dialog can close itself normally when
  // its call leaves the current turn (the live object wins while listed).
  const lastSelected = useRef<ToolCall | null>(null)
  const live = selectedId ? subagents.find((tc) => tc.toolCallId === selectedId) : undefined
  useEffect(() => {
    if (live) lastSelected.current = live
  }, [live])
  const selected = selectedId ? (live ?? lastSelected.current) : null
  const summaryParts = (['running', 'done', 'failed'] as const).filter((key) => counts[key] > 0)
  const liveSummary = summaryParts.map((key) => `${counts[key]} ${STATUS_LABEL[key]}`).join(', ')

  return (
    <>
      <AnimatePresence initial={false}>
        {subagents.length > 0 && (
          <motion.div
            key="subagent-strip"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={reduced ? { duration: 0 } : CHAT_SPRING_SOFT}
            className="shrink-0"
          >
            <div className={cn(CHAT_GUTTER_X, 'pb-2')}>
              <section
                className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg bg-card/30 ring-1 ring-border/50"
                aria-label="Subagents"
              >
                <span aria-live="polite" className="sr-only">
                  {`Subagents: ${liveSummary}`}
                </span>
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={!collapsed}
                  aria-controls={collapsed ? undefined : bodyId}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-3 py-2 text-left text-2xs font-semibold text-muted-foreground transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    CHAT_HIT_MIN_H
                  )}
                >
                  <Bot size={12} className="shrink-0" aria-hidden="true" />
                  <span className="text-balance">Subagents</span>
                  <span aria-live="polite" className="ml-auto flex items-center gap-1 tabular-nums">
                    {summaryParts.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && (
                          <span aria-hidden="true" className="text-muted-foreground/40">
                            ·
                          </span>
                        )}
                        <span
                          className={cn(
                            key === 'running' && 'text-warning',
                            key === 'done' && 'text-success',
                            key === 'failed' && 'text-destructive'
                          )}
                        >
                          {counts[key]} {STATUS_LABEL[key]}
                        </span>
                      </span>
                    ))}
                  </span>
                  <ChevronDown
                    size={14}
                    className={cn(
                      'shrink-0 text-muted-foreground transition-transform duration-[var(--acc-chevron)] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                      collapsed ? '' : 'rotate-180'
                    )}
                    aria-hidden="true"
                  />
                </button>
                <CollapseExpandMotion open={!collapsed} motion="chat">
                  <ul
                    id={bodyId}
                    className="scroller-thin flex max-h-40 flex-col overflow-y-auto overscroll-contain border-t border-border/40 px-2 pb-1.5 pt-0.5"
                  >
                    {subagents.map((tc) => {
                      const status = subagentStatus(tc, turnActive)
                      const title = subagentTitle(tc)
                      const type = subagentType(tc)
                      const metrics = subagentMetrics(tc)
                      const started = typeof tc.timestamp === 'number' ? tc.timestamp : null
                      const settledAt = endedAt[tc.toolCallId]
                      const durationMs =
                        status === 'running'
                          ? started === null
                            ? undefined
                            : now - started
                          : (metrics.totalDurationMs ??
                            (started !== null && settledAt !== undefined
                              ? settledAt - started
                              : undefined))
                      return (
                        <li key={tc.toolCallId}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(tc.toolCallId)}
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              CHAT_ROW_MIN_H
                            )}
                          >
                            <span className="inline-flex shrink-0" aria-hidden="true">
                              <StatusIcon status={status} />
                            </span>
                            <span className="sr-only">{STATUS_LABEL[status]}</span>
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {title}
                              {type && <span className="ml-1.5 text-muted-foreground">{type}</span>}
                            </span>
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
                </CollapseExpandMotion>
              </section>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {selected && (
        <SubagentDetailsDialog
          toolCall={selected}
          parentTurnActive={turnActive}
          filePathContext={filePathContext}
          open
          onOpenChange={(open) => {
            if (!open) setSelectedId(null)
          }}
        />
      )}
    </>
  )
}
