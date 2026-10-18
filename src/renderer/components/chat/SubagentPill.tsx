import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, CheckCircle2, ChevronDown, XCircle } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import type { ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
import { CHAT_ROW_MIN_H } from './chat-layout'
import { CHAT_SPRING_SOFT } from './chat-motion'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'
import {
  countSubagents,
  formatElapsed,
  formatTokens,
  type SubagentCounts,
  type SubagentStatus,
  selectCurrentTurnSubagents,
  subagentMetrics,
  subagentStatus,
  subagentTitle,
  subagentType
} from './subagent-strip'

interface SubagentPillProps {
  toolCalls: readonly ToolCall[]
  messages: readonly ChatMessage[]
  /** Session `activeTurn`: a subagent with no status yet counts as running while true. */
  turnActive: boolean
  filePathContext: FilePathResolutionContext | undefined
  /** Hide the pill (phone keyboard open). */
  hidden?: boolean
  /** False while the chat tab is hidden (tabs stay mounted); pauses the timer. */
  isVisible?: boolean
  className?: string
}

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

function CountParts({ counts }: { counts: SubagentCounts }): React.JSX.Element {
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
 * Floating top-right pill for the current turn's subagents. Takes no layout
 * height; opens a popover (desktop) or bottom sheet (phone) with one row per
 * subagent. Narrow panes collapse it to icon + total via the chat `@container`.
 */
export function SubagentPill({
  toolCalls,
  messages,
  turnActive,
  filePathContext,
  hidden = false,
  isVisible = true,
  className
}: SubagentPillProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const isMobile = useMobileWebShell()
  const [open, setOpen] = useState(false)
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
  const shown = subagents.length > 0 && !hidden

  const close = useCallback(() => setOpen(false), [])
  useOverlayRegistration('subagent-sheet', isMobile && open && shown, close)
  useEffect(() => {
    if (!shown) setOpen(false)
  }, [shown])

  // One interval for every running row, only while the list is open on a
  // visible tab. Resuming re-reads the clock, so elapsed jumps to the right value.
  const [now, setNow] = useState(() => Date.now())
  const ticking = counts.running > 0 && open && isVisible
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
  const liveSummary = COUNT_KEYS.filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${STATUS_LABEL[key]}`)
    .join(', ')

  const rows = (
    <ul className="scroller-thin flex max-h-72 flex-col overflow-y-auto overscroll-contain">
      {subagents.map((tc) => {
        const status = subagentStatus(tc, turnActive)
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
              (started !== null && settledAt !== undefined ? settledAt - started : undefined))
        return (
          <li key={tc.toolCallId}>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setSelectedId(tc.toolCallId)
              }}
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

  const trigger = (
    <button
      type="button"
      aria-label={`Subagents: ${liveSummary}`}
      className={cn(
        'pointer-events-auto relative flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover/90 px-2.5 text-2xs font-medium shadow-md backdrop-blur-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted',
        "after:absolute after:-inset-2 after:content-[''] pointer-coarse:after:-inset-y-2.5"
      )}
    >
      {counts.running > 0 ? (
        <Spinner size={13} decorative className="text-warning" />
      ) : (
        <Bot size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      {!isMobile && (
        <span className="flex items-center gap-1 tabular-nums @max-[420px]:hidden">
          <CountParts counts={counts} />
        </span>
      )}
      <span
        className={cn('tabular-nums text-foreground', !isMobile && 'hidden @max-[420px]:inline')}
      >
        {subagents.length}
      </span>
      {!isMobile && (
        <ChevronDown
          size={12}
          className="shrink-0 text-muted-foreground @max-[420px]:hidden"
          aria-hidden="true"
        />
      )}
    </button>
  )

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {shown ? `Subagents: ${liveSummary}` : ''}
      </span>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            key="subagent-pill"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={reduced ? { duration: 0 } : CHAT_SPRING_SOFT}
            className={cn('pointer-events-none origin-top-right', className)}
          >
            {isMobile ? (
              <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger asChild>{trigger}</SheetTrigger>
                <SheetContent
                  side="bottom"
                  aria-describedby={undefined}
                  className="flex max-h-[85dvh] flex-col gap-0 overscroll-contain bg-popover p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
                >
                  <SheetHeader className="space-y-0 px-2 py-2 pr-10 text-left">
                    <SheetTitle className="text-base">Subagents</SheetTitle>
                    <p className="flex items-center gap-1 text-xs tabular-nums">
                      <CountParts counts={counts} />
                    </p>
                  </SheetHeader>
                  {rows}
                </SheetContent>
              </Sheet>
            ) : (
              <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  aria-label="Subagents"
                  className="w-[min(22.5rem,calc(100vw-2rem))] p-1"
                >
                  <p className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-2xs font-semibold text-muted-foreground">
                    <Bot size={12} className="shrink-0" aria-hidden="true" />
                    Subagents · this turn
                  </p>
                  {rows}
                </PopoverContent>
              </Popover>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {selected && (
        <SubagentDetailsDialog
          toolCall={selected}
          parentTurnActive={turnActive}
          filePathContext={filePathContext}
          open
          onOpenChange={(next) => {
            if (!next) setSelectedId(null)
          }}
        />
      )}
    </>
  )
}
