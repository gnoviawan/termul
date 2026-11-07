import { useState } from 'react'
import { Square } from '@/components/icons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { ToolCall } from '@/lib/acp-api'
import { type SubagentStatus, subagentTitle } from './subagent-strip'
import { useStopSubagent } from './use-stop-subagent'

/**
 * The phone list's stop control beside a subagent row: a 44px square that
 * asks before it stops the subagent, since a tap on a list is easy to miss.
 */
export function SubagentRowStop({
  toolCall,
  status
}: {
  toolCall: ToolCall
  status: SubagentStatus
}): React.JSX.Element | null {
  const { canStop, stopping, stop } = useStopSubagent(toolCall, status)
  const [confirming, setConfirming] = useState(false)
  if (!canStop) return null
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="touch"
        aria-label={`Stop ${subagentTitle(toolCall)}`}
        data-subagent-stop={toolCall.toolCallId}
        disabled={stopping}
        onClick={() => setConfirming(true)}
        className="w-11 shrink-0 rounded-xl px-0 text-muted-foreground"
      >
        <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop agent?</AlertDialogTitle>
            <AlertDialogDescription>Its work so far is kept.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90"
              onClick={stop}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
