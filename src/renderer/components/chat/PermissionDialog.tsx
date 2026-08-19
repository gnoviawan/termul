import { useCallback, useMemo } from 'react'
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
import { useRuntimeTranslation } from '@/i18n/use-runtime-translation'
import type { PermissionOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { type PendingPermission, useAcpStore } from '@/stores/acp-store'
import {
  isAllowOption,
  isRejectOption,
  pickPrimaryAllowOption,
  pickRejectOption
} from './tool-call-format'

interface PermissionDialogProps {
  permission: PendingPermission
}

/** Title text for the requesting tool call, best-effort from the update fields. */
function toolTitle(toolCall: unknown, fallback = 'this action'): string {
  if (toolCall && typeof toolCall === 'object') {
    const t = toolCall as { title?: string; toolCallId?: string }
    return t.title ?? t.toolCallId ?? fallback
  }
  return fallback
}

function optionVariant(
  option: PermissionOption,
  primaryAllowId: string | null
): 'default' | 'secondary' | 'destructive' {
  if (isRejectOption(option)) return 'destructive'
  if (isAllowOption(option) && option.optionId === primaryAllowId) return 'default'
  return 'secondary'
}

/**
 * Permission prompt for a single pending request. Choosing an option calls
 * `respondPermission(requestId, optionId)`; Escape/dismiss resolves with an
 * explicit reject option when one exists, otherwise a plain cancel (no
 * optionId) so the request is never left dangling.
 *
 * Hierarchy: one primary Allow (safest / once), other Allows secondary, then
 * a visual break before Reject options.
 */
export function PermissionDialog({ permission }: PermissionDialogProps): React.JSX.Element {
  const t = useRuntimeTranslation('chat')
  const respond = useAcpStore((s) => s.respondPermission)

  const choose = useCallback(
    (optionId?: string) => {
      void respond(permission.requestId, optionId).catch(() => {
        toast.error(
          t('permission.responseFailed', 'Could not send the permission response. Try again.')
        )
      })
    },
    [respond, permission.requestId, t]
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

  const { allows, others, rejects, primaryAllowId } = useMemo(() => {
    const allowOpts = permission.options.filter(isAllowOption)
    const rejectOpts = permission.options.filter(isRejectOption)
    const otherOpts = permission.options.filter((o) => !isAllowOption(o) && !isRejectOption(o))
    const primary = pickPrimaryAllowOption(allowOpts)
    return {
      allows: allowOpts,
      others: otherOpts,
      rejects: rejectOpts,
      primaryAllowId: primary?.optionId ?? null
    }
  }, [permission.options])

  const renderOption = (option: PermissionOption): React.JSX.Element => (
    <Button
      key={option.optionId}
      variant={optionVariant(option, primaryAllowId)}
      className={cn('min-h-11 justify-start')}
      onClick={() => choose(option.optionId)}
    >
      {option.name}
    </Button>
  )

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('permission.title', 'Permission required')}</DialogTitle>
          <DialogDescription>
            {t('permission.description', 'The agent wants to run {{action}}.', {
              action: toolTitle(permission.toolCall, t('permission.actionFallback', 'this action'))
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {permission.options.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t('permission.noOptions', 'No options were provided.')}
            </p>
          )}
          {allows.map(renderOption)}
          {others.map(renderOption)}
          {rejects.length > 0 && (
            <div
              className={cn(
                'flex flex-col gap-2',
                (allows.length > 0 || others.length > 0) && 'mt-2 border-t border-border/60 pt-2'
              )}
            >
              {rejects.map(renderOption)}
            </div>
          )}
          {rejects.length === 0 && (
            // Guarantee a dismissal path when the agent provided no reject option.
            <Button
              variant="ghost"
              className="mt-1 min-h-11 justify-start"
              onClick={() => choose(undefined)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          )}
        </div>
        <DialogFooter className="sm:justify-start">
          <span className="text-2xs text-muted-foreground">
            {t('permission.declineHint', 'Closing this dialog declines the request.')}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
