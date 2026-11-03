import { memo } from 'react'
import { AgentIcon } from '@/components/agents/AgentIcon'
import { Bot, Check, ChevronRight, LoaderCircle, X } from '@/components/icons'
import { badgeVariants } from '@/components/ui/badge'
import type { ToolCall } from '@/lib/acp-api'
import { getAgentById } from '@/lib/agents/custom-agents'
import { cn } from '@/lib/utils'
import {
  type SubagentCounts,
  type SubagentStatus,
  subagentDetail,
  subagentTitle,
  subagentType
} from './subagent-strip'
import { useSubagentChildCalls, useSubagentSurface } from './subagent-surface-context'
import { SubagentElapsed } from './subagent-time'

export const SUBAGENT_STATUS_WORD: Record<SubagentStatus, string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}

const STATUS_TONE: Record<SubagentStatus, string> = {
  running: 'text-warning',
  done: 'text-success',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground'
}

const STATUS_DOT: Record<SubagentStatus, string> = {
  running: 'bg-warning',
  done: 'bg-success',
  failed: 'bg-destructive',
  stopped: 'bg-muted-foreground'
}

const ICON_CLASS = 'shrink-0'

export function SubagentStatusIcon({
  status,
  className
}: {
  status: SubagentStatus
  className?: string
}): React.JSX.Element {
  const tone = cn(ICON_CLASS, STATUS_TONE[status], className)
  if (status === 'running') {
    return (
      <LoaderCircle
        size={14}
        strokeWidth={2}
        className={cn(tone, 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
    )
  }
  if (status === 'done') return <Check size={14} className={tone} aria-hidden="true" />
  return <X size={14} className={tone} aria-hidden="true" />
}

/** Status icon and word in the status tone. A running subagent may be waiting on the user. */
export function SubagentStatusLabel({
  toolCall,
  status,
  wordClassName
}: {
  toolCall: ToolCall
  status: SubagentStatus
  wordClassName?: string
}): React.JSX.Element {
  const waiting = status === 'running' && toolCall.subagent?.activity === 'requires_action'
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-xs', STATUS_TONE[status])}>
      <SubagentStatusIcon status={status} />
      <span className={wordClassName}>
        {waiting ? 'Needs input' : SUBAGENT_STATUS_WORD[status]}
      </span>
    </span>
  )
}

/** The chat's agent icon in a round well, with a status dot when `status` is given. */
export function SubagentAvatar({
  status,
  size = 'md',
  className
}: {
  status?: SubagentStatus
  size?: 'sm' | 'md'
  className?: string
}): React.JSX.Element {
  const { agentId } = useSubagentSurface()
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted',
        size === 'md' ? 'size-8' : 'size-7',
        className
      )}
    >
      {agentId && getAgentById(agentId) ? (
        <AgentIcon agentId={agentId} className="size-4" />
      ) : (
        <Bot size={16} className="text-muted-foreground" />
      )}
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card',
            STATUS_DOT[status]
          )}
        />
      )}
    </span>
  )
}

/** The agent type as an outline chip. */
export function SubagentTypeChip({
  type,
  className
}: {
  type: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        badgeVariants({ variant: 'outline' }),
        'max-w-[12rem] min-w-0 shrink-[10] truncate rounded-md px-1.5 py-0 text-3xs font-normal text-muted-foreground',
        className
      )}
    >
      {type}
    </span>
  )
}

const COUNT_ORDER: readonly SubagentStatus[] = ['running', 'done', 'failed', 'stopped']

const COUNT_WORD: Record<SubagentStatus, string> = {
  running: 'working',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped'
}

/** "1 working, 2 done": the non-zero counts, for accessible names. */
export function subagentCountSummary(counts: SubagentCounts): string {
  return COUNT_ORDER.filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${COUNT_WORD[key]}`)
    .join(', ')
}

/** The non-zero counts, dot separated. Working and failed take their status tone. */
export function SubagentCountParts({ counts }: { counts: SubagentCounts }): React.JSX.Element {
  return (
    <>
      {COUNT_ORDER.filter((key) => counts[key] > 0).map((key, i) => (
        <span key={key} className="flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          )}
          <span className={key === 'done' ? 'text-muted-foreground' : STATUS_TONE[key]}>
            {counts[key]} {COUNT_WORD[key]}
          </span>
        </span>
      ))}
    </>
  )
}

/** A row narrower than the chips need (phone, docked panel beside the chat) keeps the title. */
const NARROW_HIDDEN = '@max-[36rem]:hidden'

interface SubagentRowProps {
  toolCall: ToolCall
  status: SubagentStatus
  /** The ids of the list the row sits in, for the panel's "i of n". */
  siblings: readonly string[]
  /** The surface under the row, for its hover wash. */
  surface?: 'card' | 'popover'
  /** Opening from the panel's Activity keeps the current subagent under it. */
  nested?: boolean
  /** Runs before the panel opens (the pill closes its popover). */
  onOpen?: () => void
}

/**
 * One subagent: avatar with status dot, title, type chip, one detail line,
 * status and elapsed time. Opens the chat's subagent panel. The same row
 * serves the transcript, the status pill and nested subagents.
 */
function SubagentRowComponent({
  toolCall,
  status,
  siblings,
  surface = 'card',
  nested = false,
  onOpen
}: SubagentRowProps): React.JSX.Element {
  const { open, openId, opensDialog } = useSubagentSurface()
  const childCalls = useSubagentChildCalls(toolCall.toolCallId)
  const title = subagentTitle(toolCall)
  const type = subagentType(toolCall)
  const detail = subagentDetail(toolCall, status, childCalls)
  const selected = openId === toolCall.toolCallId && surface === 'card'

  return (
    <button
      type="button"
      data-subagent-row={toolCall.toolCallId}
      aria-haspopup={opensDialog ? 'dialog' : undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => {
        onOpen?.()
        open(toolCall.toolCallId, siblings, { nested })
      }}
      className={cn(
        '@container flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring',
        selected
          ? 'keycap'
          : surface === 'popover'
            ? 'hover:bg-foreground/[0.06]'
            : 'hover:bg-foreground/[0.03]'
      )}
    >
      <SubagentAvatar status={status} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
          {type && <SubagentTypeChip type={type} className={NARROW_HIDDEN} />}
          {toolCall.subagent?.background && (
            <SubagentTypeChip type="background" className={NARROW_HIDDEN} />
          )}
        </span>
        {detail && (
          <span
            className={cn(
              'truncate text-xs',
              detail.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {detail.text}
          </span>
        )}
      </span>
      <SubagentStatusLabel
        toolCall={toolCall}
        status={status}
        wordClassName="@max-[36rem]:sr-only"
      />
      <SubagentElapsed toolCall={toolCall} status={status} className="min-w-[5ch]" />
      <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  )
}

export const SubagentRow = memo(SubagentRowComponent)
