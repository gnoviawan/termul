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
        size="sm"
        className={cn(
          'h-8 min-w-0 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-[transform,color,background-color,border-color] duration-150 active:scale-[0.96]',
          primary && 'shadow-2xs',
          !primary &&
            !reject &&
            'border-border/70 bg-secondary/30 text-foreground hover:bg-secondary/70 hover:text-foreground',
          reject &&
            'border-transparent text-muted-foreground hover:border-destructive/25 hover:bg-destructive/10 hover:text-destructive'
        )}
        onClick={() => choose(option.optionId)}
        title={option.name}
      >
        {allow ? (
          <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
        ) : reject ? (
          <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
        ) : null}
        <span className="truncate">{option.name}</span>
      </Button>
    )
  }

  const rejectOnCancel = pickRejectOption(permission.options)

  return (
    <section
      aria-labelledby={`permission-title-${permission.requestId}`}
      aria-live="polite"
      className={cn(
        'px-3.5 py-3 sm:px-4',
        embedded
          ? 'rounded-t-[15px] border-b border-warning/20 bg-warning/[0.035]'
          : 'rounded-2xl border border-warning/25 bg-card shadow-sm'
      )}
      data-testid="permission-prompt"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/15 text-warning">
          <ShieldAlert size={13} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id={`permission-title-${permission.requestId}`}
            className="text-xs font-semibold leading-5 text-foreground"
          >
            Approval needed
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            The agent is waiting for permission to run{' '}
            <code className="rounded border border-border/50 bg-muted/60 px-1.5 py-0.5 font-mono text-xs text-foreground break-all select-all">
              {toolTitle(permission.toolCall)}
            </code>
            .
          </p>
        </div>
      </div>

      {permission.options.length === 0 && (
        <p className="ml-8 mt-2 text-xs leading-relaxed text-muted-foreground">
          The agent provided no choices. Cancel the request to keep this action blocked.
        </p>
      )}

      <fieldset className="mt-2.5 flex flex-wrap items-center gap-2">
        <legend className="sr-only">Permission options</legend>
        {allows.map(renderOption)}
        {others.map(renderOption)}
        {rejects.length > 0 ? (
          rejects.map(renderOption)
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg px-2.5 text-xs text-muted-foreground transition-[transform,color,background-color] duration-150 hover:bg-destructive/10 hover:text-destructive active:scale-[0.96]"
            onClick={() => choose(undefined)}
          >
            <ShieldAlert size={14} className="shrink-0" aria-hidden="true" />
            <span>Cancel request</span>
          </Button>
        )}
      </fieldset>
      {rejectOnCancel && (
        <p className="mt-2 text-[11px] leading-tight text-muted-foreground/70">
          Choose an option to resume the agent. This request stays here until you respond.
        </p>
      )}
    </section>
  )
}
