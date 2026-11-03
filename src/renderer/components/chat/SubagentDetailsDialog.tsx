import type { Subagent, SubagentEndReason } from '@shared/types/subagent'
import { useReducedMotion } from 'framer-motion'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import type { FilePathResolutionContext } from '@/lib/file-path-links'
import { AgentProse } from './ChatMessage'
import { SubagentActivityList } from './SubagentActivityList'
import { renderContentItem } from './ToolCallCard'
import {
  describeToolCall,
  isSubagentRunning,
  type ParentTurn,
  readableOutput
} from './tool-call-summary'

const END_STATUS: Record<SubagentEndReason, string> = {
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  unexplained: 'Stopped'
}

/** Header status line. A running record the turn rules no longer count lost its end. */
function subagentStatusText(subagent: Subagent | undefined, running: boolean): string {
  if (!subagent) return 'Status unavailable'
  if (running) {
    if (subagent.activity === 'requires_action') return 'Waiting for input'
    return subagent.background ? 'Running in background' : 'Running'
  }
  switch (subagent.activity) {
    case 'idle':
      return END_STATUS[subagent.end.reason]
    case 'unknown':
      return 'Status unavailable'
    case 'running':
    case 'requires_action':
      return subagent.background ? 'Completed' : 'Status unavailable'
  }
}

/**
 * Read-only details dialog for a subagent/Task delegation (the chat list owns
 * it so it survives virtualized row removal — ToolCallCard only reports the
 * open request through `onOpenSubagent`).
 */
export function SubagentDetailsDialog({
  toolCall,
  childToolCalls = [],
  parentTurn = 'superseded',
  open,
  onOpenChange,
  filePathContext
}: {
  toolCall: ToolCall
  /** Tool calls the subagent made (`parentToolCallId` = this dispatch). */
  childToolCalls?: readonly ToolCall[]
  parentTurn?: ParentTurn
  open: boolean
  onOpenChange: (open: boolean) => void
  filePathContext: FilePathResolutionContext | undefined
}): React.JSX.Element {
  const { primary } = describeToolCall(toolCall)
  const subagent = toolCall.subagent
  const taskPrompt = subagent?.prompt
  const reduced = useReducedMotion() ?? false
  const running = isSubagentRunning(toolCall, parentTurn)
  const background = subagent?.background === true
  const taskStatus = subagentStatusText(subagent, running)
  const content = toolCall.content ?? []
  const hasContent = content.length > 0
  const resultText = hasContent ? '' : readableOutput(toolCall.rawOutput)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(85vh,48rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden"
        onClick={(event) => {
          const target = event.target as Element
          if (event.defaultPrevented && target.closest('[data-testid="termul-file-path"]')) {
            onOpenChange(false)
          }
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle className="break-words">{primary}</DialogTitle>
          <DialogDescription>{taskStatus}</DialogDescription>
        </DialogHeader>
        <div className="scroller-thin min-h-0 space-y-4 overflow-y-auto">
          {taskPrompt && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Task prompt</h3>
              <p className="whitespace-pre-wrap break-words text-sm">{taskPrompt}</p>
            </section>
          )}
          {background && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Background agent</h3>
              <p className="text-sm text-muted-foreground">
                This agent continues after its launch. It sends its final report to the main agent,
                not to this card.
              </p>
              {subagent?.outputFile && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  Output file: {subagent.outputFile}
                </p>
              )}
            </section>
          )}
          {childToolCalls.length > 0 && (
            <SubagentActivityList childToolCalls={childToolCalls} parentTurnActive={running} />
          )}
          {toolCall.subagentText && (
            <section className="space-y-1.5" data-testid="subagent-output">
              <h3 className="text-xs font-medium text-muted-foreground">Subagent output</h3>
              <AgentProse
                text={toolCall.subagentText}
                streaming={running}
                reduced={reduced}
                filePathContext={filePathContext}
              />
            </section>
          )}
          {(hasContent || resultText) && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">
                {background ? 'Launch receipt' : 'Result'}
              </h3>
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
                          filePathContext={filePathContext}
                        />
                      ) : (
                        rendered
                      )
                    })
                  : resultText && (
                      <AgentProse
                        text={resultText}
                        streaming={false}
                        reduced={reduced}
                        filePathContext={filePathContext}
                      />
                    )}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
