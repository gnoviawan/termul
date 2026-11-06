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
import { runReloadChat } from '@/hooks/use-reload-chat'
import type { SessionId } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { useReloadConfirmStore } from '@/stores/reload-confirm-store'

/** What a reload stops, as the confirm says it. */
function stoppedWorkText(agents: number, commands: number): string {
  const agentCount = agents === 1 ? '1 background agent' : `${agents} background agents`
  const commandCount = commands === 1 ? '1 command' : `${commands} commands`
  if (commands === 0) {
    return `${agentCount} ${agents === 1 ? 'is' : 'are'} still running. A reload starts a new agent process, and the running agents stop. Their reports do not come back to this chat.`
  }
  if (agents === 0) {
    return commands === 1
      ? `${commandCount} is still running in the background. A reload starts a new agent process, and the command stops. Its output does not come back to this chat.`
      : `${commandCount} are still running in the background. A reload starts a new agent process, and the commands stop. Their output does not come back to this chat.`
  }
  return `${agentCount} and ${commandCount} are still running. A reload starts a new agent process, and they stop. Their results do not come back to this chat.`
}

/** Confirm for a reload while background agents or commands of this chat still run. */
export function ReloadChatConfirmDialog({
  sessionId
}: {
  sessionId: SessionId
}): React.JSX.Element | null {
  const request = useReloadConfirmStore((s) =>
    s.request?.sessionId === sessionId ? s.request : null
  )
  const clear = useReloadConfirmStore((s) => s.clear)
  if (!request) return null
  const running = `${request.backgroundAgents} background agents and ${request.backgroundCommands} background commands running`
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // The confirm action clears the request before Radix closes the dialog.
        if (open || !useReloadConfirmStore.getState().request) return
        clear()
        void logFrontendError({
          level: 'info',
          source: 'acp.reloadChat',
          message: `Reload of chat ${sessionId} cancelled: ${running}`
        })
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reload this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            {stoppedWorkText(request.backgroundAgents, request.backgroundCommands)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill/90"
            onClick={() => {
              useReloadConfirmStore.getState().clear()
              void logFrontendError({
                level: 'info',
                source: 'acp.reloadChat',
                message: `Reload of chat ${sessionId} confirmed with ${running}`
              })
              runReloadChat(sessionId)
            }}
          >
            Reload anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
