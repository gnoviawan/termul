import { useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { type PendingPermission, useAcpStore } from '@/stores/acp-store'
import { isAllowOption, isRejectOption, pickRejectOption } from './tool-call-format'

interface PermissionDialogProps {
  permission: PendingPermission
}

/** Title text for the requesting tool call, best-effort from the update fields. */
function toolTitle(toolCall: unknown): string {
  if (toolCall && typeof toolCall === 'object') {
    const t = toolCall as { title?: string; toolCallId?: string }
    return t.title ?? t.toolCallId ?? 'this action'
  }
  return 'this action'
}

/**
 * Permission prompt for a single pending request. Choosing an option calls
 * `respondPermission(requestId, optionId)`; Escape/dismiss resolves with an
 * explicit reject option when one exists (otherwise leaves it open).
 */
export function PermissionDialog({ permission }: PermissionDialogProps): React.JSX.Element {
  const respond = useAcpStore((s) => s.respondPermission)

  const choose = useCallback(
    (optionId?: string) => {
      void respond(permission.requestId, optionId).catch((err) => {
        toast.error(`Permission response failed: ${String(err)}`)
      })
    },
    [respond, permission.requestId]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) return
      // Dialog dismissed (Escape / overlay / Cancel button): resolve with a
      // reject option if the agent offered one; otherwise send a plain cancel
      // (no optionId) so the request is never left dangling (per Boundaries).
      const reject = pickRejectOption(permission.options)
      choose(reject ? reject.optionId : undefined)
    },
    [permission.options, choose]
  )

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Permission required</DialogTitle>
          <DialogDescription>
            The agent wants to run{' '}
            <span className="font-medium">{toolTitle(permission.toolCall)}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {permission.options.length === 0 && (
            <p className="text-sm text-muted-foreground">No options were provided.</p>
          )}
          {permission.options.map((option) => (
            <Button
              key={option.optionId}
              variant={
                isRejectOption(option)
                  ? 'destructive'
                  : isAllowOption(option)
                    ? 'default'
                    : 'secondary'
              }
              className={cn('justify-start')}
              onClick={() => choose(option.optionId)}
            >
              {option.name}
            </Button>
          ))}
          {!pickRejectOption(permission.options) && (
            // Guarantee a dismissal path when the agent provided no reject option.
            <Button variant="ghost" className="justify-start" onClick={() => choose(undefined)}>
              Cancel
            </Button>
          )}
        </div>
        <DialogFooter className="sm:justify-start">
          <span className="text-[11px] text-muted-foreground">
            Closing this dialog declines the request.
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
