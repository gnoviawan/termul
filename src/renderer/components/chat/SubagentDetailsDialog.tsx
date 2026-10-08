import { useReducedMotion } from 'framer-motion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import { AgentProse } from './ChatMessage'
import { renderContentItem } from './ToolCallCard'
import {
  describeToolCall,
  firstString,
  isToolCallRunning,
  readableOutput
} from './tool-call-summary'

/**
 * Read-only details dialog for a subagent/Task delegation (the chat list owns
 * it so it survives virtualized row removal — ToolCallCard only reports the
 * open request through `onOpenSubagent`).
 */
export function SubagentDetailsDialog({
  toolCall,
  parentTurnActive = false,
  open,
  onOpenChange
}: {
  toolCall: ToolCall
  parentTurnActive?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { primary } = describeToolCall(toolCall)
  const input =
    toolCall.rawInput && typeof toolCall.rawInput === 'object'
      ? (toolCall.rawInput as Record<string, unknown>)
      : null
  const taskPrompt = firstString(input, ['prompt'])
  const activityKind = firstString(input, ['activityKind', 'activity_kind'])
  const reduced = useReducedMotion() ?? false
  const running = isToolCallRunning(toolCall) || (parentTurnActive && toolCall.status == null)
  const taskStatus = running
    ? 'Running'
    : toolCall.status === 'completed'
      ? 'Completed'
      : toolCall.status === 'failed'
        ? 'Failed'
        : 'Status unavailable'
  const content = toolCall.content ?? []
  const hasContent = content.length > 0
  const resultText = hasContent ? '' : readableOutput(toolCall.rawOutput)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(85vh,48rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="pr-6">
          <DialogTitle className="break-words">{primary}</DialogTitle>
          <DialogDescription>
            {activityKind ? `${taskStatus} · ${activityKind}` : taskStatus}
          </DialogDescription>
        </DialogHeader>
        <div className="scroller-thin min-h-0 space-y-4 overflow-y-auto">
          {taskPrompt && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Task prompt</h3>
              <p className="whitespace-pre-wrap break-words text-sm">{taskPrompt}</p>
            </section>
          )}
          {(hasContent || resultText) && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Result</h3>
              <div className="space-y-2">
                {hasContent
                  ? content.map((item, i) => {
                      const block =
                        item.type === 'content'
                          ? (item as { content?: ContentBlock }).content
                          : undefined
                      const rendered = renderContentItem(item, i, undefined, {
                        terminalOutput:
                          typeof toolCall.terminalOutput === 'string'
                            ? toolCall.terminalOutput
                            : undefined,
                        terminalExitCode:
                          typeof toolCall.terminalExitCode === 'number'
                            ? toolCall.terminalExitCode
                            : undefined
                      })
                      return block?.type === 'text' ? (
                        <AgentProse
                          key={i}
                          text={block.text ?? ''}
                          streaming={false}
                          reduced={reduced}
                        />
                      ) : (
                        rendered
                      )
                    })
                  : resultText && (
                      <AgentProse text={resultText} streaming={false} reduced={reduced} />
                    )}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
