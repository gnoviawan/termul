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

/** Confirm for a reload while background agents of this chat still run. */
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
  const count = request.backgroundAgents
  const agents = count === 1 ? '1 background agent is' : `${count} background agents are`
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
          message: `Reload of chat ${sessionId} cancelled: ${count} background agents running`
        })
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reload this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            {agents} still running. A reload starts a new agent process, and the running agents
            stop. Their reports do not come back to this chat.
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
                message: `Reload of chat ${sessionId} confirmed with ${count} background agents running`
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
