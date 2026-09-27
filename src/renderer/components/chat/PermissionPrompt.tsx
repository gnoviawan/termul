import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { ShieldAlert, ShieldCheck } from '@/components/icons'
import { Button } from '@/components/ui/button'
import type { PermissionOption } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { type PendingPermission, useAcpStore } from '@/stores/acp-store'
import {
  isAllowOption,
  isRejectOption,
  pickPrimaryAllowOption,
  pickRejectOption
} from './tool-call-format'

interface PermissionPromptProps {
  permission: PendingPermission
  /** Render flush with the composer surface instead of as a standalone panel. */
  embedded?: boolean
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
 * Inline approval prompt for a single pending request. It intentionally has
 * no dismiss or outside-click behavior; the agent stays paused until the user
 * chooses an option or explicitly cancels the request.
 */
export function PermissionPrompt({
  permission,
  embedded = true
}: PermissionPromptProps): React.JSX.Element {
  const respond = useAcpStore((s) => s.respondPermission)

  const choose = useCallback(
    (optionId?: string) => {
      void respond(permission.requestId, optionId).catch(() => {
        toast.error('Could not send the permission response. Try again.')
      })
    },
    [respond, permission.requestId]
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

  const renderOption = (option: PermissionOption): React.JSX.Element => {
    const allow = isAllowOption(option)
    const reject = isRejectOption(option)
    const primary = allow && option.optionId === primaryAllowId

    return (
      <Button
        key={option.optionId}
        variant={primary ? 'default' : 'outline'}
        className={cn(
          'h-auto min-h-10 min-w-0 justify-start rounded-xl px-3 py-2 text-left text-xs leading-snug whitespace-normal sm:text-sm',
          !primary && !reject && 'border-border/70 bg-background/40 hover:bg-secondary/60',
          reject &&
            'border-destructive/25 bg-destructive/[0.04] text-destructive hover:bg-destructive/10 hover:text-destructive'
        )}
        onClick={() => choose(option.optionId)}
      >
        {allow ? (
          <ShieldCheck size={15} className="shrink-0" aria-hidden="true" />
        ) : reject ? (
          <ShieldAlert size={15} className="shrink-0" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 break-words">{option.name}</span>
      </Button>
    )
  }

  const rejectOnCancel = pickRejectOption(permission.options)

  return (
    <section
      aria-labelledby={`permission-title-${permission.requestId}`}
      aria-live="polite"
      className={cn(
        'px-3 py-3 sm:px-4',
        embedded
          ? 'rounded-t-[15px] border-b border-warning/20 bg-warning/[0.035]'
          : 'rounded-2xl border border-warning/25 bg-card shadow-sm'
      )}
      data-testid="permission-prompt"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-warning/25 bg-warning/10 text-warning">
          <ShieldAlert size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id={`permission-title-${permission.requestId}`}
            className="text-sm font-semibold leading-5 text-foreground"
          >
            Approval needed
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            The agent is waiting for permission to run{' '}
            <span className="break-words font-medium text-foreground">
              {toolTitle(permission.toolCall)}
            </span>
            .
          </p>
        </div>
      </div>

      {permission.options.length === 0 && (
        <p className="ml-10 mt-2 text-xs leading-relaxed text-muted-foreground">
          The agent provided no choices. Cancel the request to keep this action blocked.
        </p>
      )}

      <fieldset className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        <legend className="sr-only">Permission options</legend>
        {allows.map(renderOption)}
        {others.map(renderOption)}
        {rejects.length > 0 ? (
          rejects.map(renderOption)
        ) : (
          <Button
            variant="ghost"
            className="h-auto min-h-10 justify-start rounded-xl px-3 py-2 text-left text-xs text-muted-foreground whitespace-normal hover:text-foreground sm:text-sm"
            onClick={() => choose(undefined)}
          >
            <ShieldAlert size={15} className="shrink-0" aria-hidden="true" />
            <span>Cancel request</span>
          </Button>
        )}
      </fieldset>
      {rejectOnCancel && (
        <p className="mt-2 text-2xs text-muted-foreground">
          Choose an option to resume the agent. This request stays here until you respond.
        </p>
      )}
    </section>
  )
}
