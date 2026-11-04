import { motion, useReducedMotion } from 'framer-motion'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ToolCall } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { CHEVRON_TRANSITION } from './chat-motion'
import {
  SubagentAvatar,
  SubagentCountParts,
  SubagentRow,
  subagentCountSummary
} from './SubagentRow'
import { countSubagents, subagentStatus } from './subagent-strip'
import { SubagentSpanElapsed } from './subagent-time'
import type { ParentTurn } from './tool-call-summary'

const MAX_AVATARS = 3

const CARD_CLASS = 'flex flex-col gap-0.5 rounded-xl border border-border bg-card p-1'

interface SubagentGroupProps {
  /** Subagent dispatches launched together, in launch order. */
  calls: readonly ToolCall[]
  /** Where their turn stands. */
  parentTurn: ParentTurn
  /** Inside the panel's Activity: opening a row keeps the current subagent under it. */
  nested?: boolean
}

/**
 * Subagents launched together. One subagent is one card. Several get a
 * header with their avatars, a status summary and the span they ran; the
 * list stays open while any runs and folds once all settle, dimmed.
 */
function SubagentGroupComponent({
  calls,
  parentTurn,
  nested = false
}: SubagentGroupProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const members = useMemo(
    () => calls.map((toolCall) => ({ toolCall, status: subagentStatus(toolCall, parentTurn) })),
    [calls, parentTurn]
  )
  const siblings = useMemo(() => calls.map((tc) => tc.toolCallId), [calls])
  const counts = countSubagents(members.map((member) => member.status))
  const live = counts.running > 0
  const [open, setOpen] = useState(live)
  const wasLive = useRef(live)
  useEffect(() => {
    if (live) setOpen(true)
    else if (wasLive.current) setOpen(false)
    wasLive.current = live
  }, [live])

  const rows = members.map(({ toolCall, status }) => (
    <SubagentRow
      key={toolCall.toolCallId}
      toolCall={toolCall}
      status={status}
      siblings={siblings}
      nested={nested}
    />
  ))

  if (members.length === 1) {
    return (
      <div data-subagent-group="single" className={cn(CARD_CLASS, 'my-1.5')}>
        {rows}
      </div>
    )
  }

  const extra = members.length - MAX_AVATARS
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-subagent-group="multi"
      className={cn('my-1.5 min-w-0 transition-opacity', !open && !live && 'opacity-60')}
    >
      <CollapsibleTrigger
        data-press-feedback="off"
        aria-label={`${members.length} subagents: ${subagentCountSummary(counts)}`}
        className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {members.slice(0, MAX_AVATARS).map(({ toolCall, status }, i) => (
            <SubagentAvatar
              key={toolCall.toolCallId}
              status={status}
              size="sm"
              className={cn('ring-2 ring-background', i > 0 && '-ml-2')}
            />
          ))}
          {extra > 0 && (
            <span className="-ml-2 inline-flex size-7 items-center justify-center rounded-full border border-border bg-muted text-xs tabular-nums text-muted-foreground ring-2 ring-background">
              +{extra}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">{members.length} subagents</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs tabular-nums">
            <SubagentCountParts counts={counts} />
          </span>
        </span>
        <SubagentSpanElapsed members={members} />
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ rotate: open ? 90 : 0 }}
          transition={reduced ? { duration: 0 } : CHEVRON_TRANSITION}
        >
          <ChevronRight size={14} />
        </motion.span>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount>
        <CollapseExpandMotion open={open} motion="chat">
          <div className={cn(CARD_CLASS, 'mt-1')}>{rows}</div>
        </CollapseExpandMotion>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Memoized: the turn re-renders on every stream chunk; an unchanged group bails. */
export const SubagentGroup = memo(SubagentGroupComponent)
