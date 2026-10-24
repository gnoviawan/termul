import { CheckCircle2, Circle, LoaderCircle, XCircle } from '@/components/icons'
import type { ToolCall } from '@/lib/acp-api'
import { describeToolCall, isToolCallRunning } from './tool-call-summary'

/** Rows shown in the dialog; the newest calls win when a subagent made more. */
export const MAX_SUBAGENT_ACTIVITY_ROWS = 50

function ActivityIcon({
  toolCall,
  parentTurnActive
}: {
  toolCall: ToolCall
  parentTurnActive: boolean
}): React.JSX.Element {
  if (toolCall.status === 'failed') {
    return <XCircle size={13} className="shrink-0 text-destructive" aria-label="Failed" />
  }
  if (toolCall.status === 'completed') {
    return <CheckCircle2 size={13} className="shrink-0 text-success" aria-label="Done" />
  }
  if (parentTurnActive && (isToolCallRunning(toolCall) || toolCall.status == null)) {
    return (
      <LoaderCircle
        size={13}
        className="shrink-0 animate-spin text-warning motion-reduce:animate-none"
        aria-label="Running"
      />
    )
  }
  return <Circle size={13} className="shrink-0 text-muted-foreground" aria-label="No status" />
}

/** The tool calls a subagent made, as one compact line each. */
export function SubagentActivityList({
  childToolCalls,
  parentTurnActive
}: {
  childToolCalls: readonly ToolCall[]
  parentTurnActive: boolean
}): React.JSX.Element {
  const hidden = Math.max(0, childToolCalls.length - MAX_SUBAGENT_ACTIVITY_ROWS)
  const rows = hidden > 0 ? childToolCalls.slice(hidden) : childToolCalls
  return (
    <section className="space-y-1.5" data-testid="subagent-activity">
      <h3 className="text-xs font-medium text-muted-foreground">
        Activity · {childToolCalls.length}{' '}
        {childToolCalls.length === 1 ? 'tool call' : 'tool calls'}
      </h3>
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">{hidden} earlier tool calls are not shown.</p>
      )}
      <ul className="space-y-1">
        {rows.map((call) => {
          const { verb, primary, detail } = describeToolCall(call)
          return (
            <li key={call.toolCallId} className="flex min-w-0 items-center gap-2 text-sm">
              <ActivityIcon toolCall={call} parentTurnActive={parentTurnActive} />
              <span className="min-w-0 truncate">
                {verb && <span className="text-muted-foreground">{verb} </span>}
                <span>{primary}</span>
                {detail && <span className="text-muted-foreground"> {detail}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
