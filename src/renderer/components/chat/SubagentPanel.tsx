import { useReducedMotion } from 'framer-motion'
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Clock, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { IconActionButton } from '@/components/ui/icon-action-button'
import type { ToolCall } from '@/lib/acp-api'
import { getAgentById } from '@/lib/agents/custom-agents'
import { cn } from '@/lib/utils'
import { AgentProse } from './chat-agent-prose'
import { SubagentGroup } from './SubagentGroup'
import { SubagentAvatar, SubagentStatusLabel } from './SubagentRow'
import {
  formatTokens,
  type SubagentStatus,
  subagentResultText,
  subagentTitle,
  subagentToolCount,
  subagentType
} from './subagent-strip'
import { useSubagentChildCalls, useSubagentSurface } from './subagent-surface-context'
import { SubagentElapsed } from './subagent-time'
import { ToolCallCard } from './ToolCallCard'
import { isSubagentCall, type ParentTurn } from './tool-call-summary'

/** Activity rows shown; the newest win when a subagent made more. */
export const MAX_SUBAGENT_ACTIVITY_ROWS = 50

function Section({
  title,
  children
}: {
  title: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/** A section the agent sent no data for: one muted line saying why. */
function Missing({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

function TaskPrompt({ prompt }: { prompt: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [expanded])
  return (
    <Section title="Task">
      <p
        ref={ref}
        className={cn(
          'whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm text-foreground',
          !expanded && 'line-clamp-3'
        )}
      >
        {prompt}
      </p>
      {(overflows || expanded) && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="self-start px-0"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </Button>
      )}
    </Section>
  )
}

type ActivitySegment =
  | { kind: 'tool'; toolCall: ToolCall }
  | { kind: 'subagents'; key: string; calls: ToolCall[] }

/** Child calls in order, with consecutive nested subagents folded into one group. */
function activitySegments(calls: readonly ToolCall[]): ActivitySegment[] {
  const segments: ActivitySegment[] = []
  for (const call of calls) {
    const last = segments[segments.length - 1]
    if (!isSubagentCall(call)) segments.push({ kind: 'tool', toolCall: call })
    else if (last?.kind === 'subagents') last.calls.push(call)
    else segments.push({ kind: 'subagents', key: call.toolCallId, calls: [call] })
  }
  return segments
}

function Activity({
  toolCall,
  childCalls,
  parentTurn,
  agentName
}: {
  toolCall: ToolCall
  childCalls: readonly ToolCall[]
  parentTurn: ParentTurn
  agentName: string
}): React.JSX.Element {
  const { filePathContext } = useSubagentSurface()
  const hidden = Math.max(0, childCalls.length - MAX_SUBAGENT_ACTIVITY_ROWS)
  const segments = useMemo(
    () => activitySegments(hidden > 0 ? childCalls.slice(hidden) : childCalls),
    [childCalls, hidden]
  )
  const transcript = toolCall.subagent?.caps.transcript ?? 'none'
  if (childCalls.length === 0) {
    if (transcript === 'final') {
      return <Missing>{agentName} reports only this subagent's result, not its steps.</Missing>
    }
    if (transcript === 'none') {
      return <Missing>{agentName} doesn't report what this subagent does.</Missing>
    }
    return <Missing>No tool calls to show.</Missing>
  }
  return (
    <Section title={<span className="tabular-nums">Activity · {childCalls.length}</span>}>
      {hidden > 0 && <Missing>{hidden} earlier tool calls are not shown.</Missing>}
      <div className="flex min-w-0 flex-col">
        {segments.map((segment) =>
          segment.kind === 'tool' ? (
            <ToolCallCard
              key={segment.toolCall.toolCallId}
              toolCall={segment.toolCall}
              filePathContext={filePathContext}
            />
          ) : (
            <SubagentGroup key={segment.key} calls={segment.calls} parentTurn={parentTurn} nested />
          )
        )}
      </div>
    </Section>
  )
}

function Outcome({
  toolCall,
  status,
  agentName
}: {
  toolCall: ToolCall
  status: SubagentStatus
  agentName: string
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const { filePathContext } = useSubagentSurface()
  const record = toolCall.subagent
  const prose = (text: string, streaming: boolean) => (
    <AgentProse
      text={text}
      streaming={streaming}
      reduced={reduced}
      filePathContext={filePathContext}
      linkScope={`subagent:${toolCall.toolCallId}`}
    />
  )

  const outputFile = record?.background ? record.outputFile : undefined
  const outputLine = outputFile && (
    <p className="break-all font-mono text-xs text-muted-foreground">Output file: {outputFile}</p>
  )

  if (status === 'running') {
    const latest = toolCall.subagentText?.trim() ? toolCall.subagentText : undefined
    return (
      <>
        {latest ? (
          <Section title="Latest message">{prose(latest, true)}</Section>
        ) : (
          record?.caps.transcript !== 'live' && (
            <Missing>The result shows here when it finishes.</Missing>
          )
        )}
        {outputLine}
      </>
    )
  }

  const result = subagentResultText(toolCall)
  const error = record?.activity === 'idle' ? record.end.error?.trim() : undefined
  if (!result && !error) {
    return (
      <>
        <Missing>
          {record?.background
            ? `This subagent ran in the background and reported to ${agentName}, not to this chat.`
            : 'The subagent returned no result.'}
        </Missing>
        {outputLine}
      </>
    )
  }
  return (
    <Section title="Result">
      {error && error !== result?.trim() && (
        <p className="whitespace-pre-wrap break-words text-sm text-destructive">{error}</p>
      )}
      {result && prose(result, false)}
      {outputLine}
    </Section>
  )
}

export interface SubagentPanelProps {
  toolCall: ToolCall
  status: SubagentStatus
  parentTurn: ParentTurn
  /** Place in the list the panel opened from. */
  position: { index: number; total: number }
  onBack: () => void
  onClose: () => void
  /** Step to the previous (-1) or next (+1) sibling. */
  onStep: (delta: -1 | 1) => void
  /** Renders the title (a sheet needs its own accessible title element). */
  renderTitle?: (title: string) => ReactNode
}

/**
 * The detail view of one subagent: who it is and how it stands, the task it
 * was given, the tool calls it made, and its latest message or result. A
 * section the agent did not report is one muted line saying why.
 */
export function SubagentPanel({
  toolCall,
  status,
  parentTurn,
  position,
  onBack,
  onClose,
  onStep,
  renderTitle
}: SubagentPanelProps): React.JSX.Element {
  const { agentId } = useSubagentSurface()
  const childCalls = useSubagentChildCalls(toolCall.toolCallId)
  const record = toolCall.subagent
  const title = subagentTitle(toolCall)
  const agentName = (agentId && getAgentById(agentId)?.name) || 'The agent'
  const toolCount = subagentToolCount(toolCall, childCalls)
  const totalTokens = record?.usage?.totalTokens
  const meta = [
    subagentType(toolCall),
    record?.model,
    toolCount ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : undefined,
    totalTokens !== undefined ? formatTokens(totalTokens) : undefined
  ].filter(Boolean)

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys step siblings from anywhere inside; every control inside stays its own focus target
    <div
      data-testid="subagent-panel"
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        } else if (position.total > 1 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault()
          onStep(event.key === 'ArrowUp' ? -1 : 1)
        }
      }}
    >
      <div className="flex items-center gap-1 px-1.5 pt-1.5">
        <IconActionButton label="Back" onClick={onBack}>
          <ArrowLeft />
        </IconActionButton>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
          Subagent of this chat
          {position.total > 1 && ` · ${position.index + 1} of ${position.total}`}
        </span>
        <IconActionButton label="Close" onClick={onClose}>
          <X />
        </IconActionButton>
      </div>
      <div className="flex items-center gap-3 border-b border-border px-4 pb-3">
        <SubagentAvatar status={status} />
        <div className="flex min-w-0 flex-1 flex-col">
          {renderTitle ? (
            renderTitle(title)
          ) : (
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          )}
          {meta.length > 0 && (
            <p className="break-words text-xs tabular-nums text-muted-foreground">
              {meta.join(' · ')}
            </p>
          )}
        </div>
        <div data-slot="subagent-actions" className="flex shrink-0 items-center gap-2">
          <SubagentStatusLabel toolCall={toolCall} status={status} />
          <SubagentElapsed toolCall={toolCall} status={status} />
        </div>
      </div>
      <div className="scroller-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-4">
        {record?.prompt?.trim() ? (
          <TaskPrompt key={toolCall.toolCallId} prompt={record.prompt} />
        ) : (
          <Missing>{agentName} did not share the task it gave this subagent.</Missing>
        )}
        <Activity
          toolCall={toolCall}
          childCalls={childCalls}
          parentTurn={parentTurn}
          agentName={agentName}
        />
        <Outcome toolCall={toolCall} status={status} agentName={agentName} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-xs text-muted-foreground">
        <Clock size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">Runs on its own — you can't message a subagent.</span>
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Back to chat
        </Button>
      </div>
    </div>
  )
}
