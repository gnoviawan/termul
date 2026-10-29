import { useState } from 'react'
import { toast } from 'sonner'
import { Check, ExternalLink } from '@/components/icons'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import {
  type AccountReadiness,
  accountReadiness,
  NOT_READY_REASON,
  StatusDot
} from '@/components/settings/provider/account-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import {
  fiveHourUsage,
  planLabel,
  type UsageReading,
  type UsageTone,
  usageTone
} from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'
import { switchProjectClaudeAccount } from '@/stores/claude-account-switch'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { type ChatClaudeAccount, useChatClaudeAccount } from './use-chat-claude-account'
import {
  type AccountChoice,
  type ProjectClaudeAccount,
  useProjectClaudeAccount
} from './use-project-claude-account'

const TONE_TEXT: Record<UsageTone, string> = {
  normal: 'text-secondary-foreground',
  warning: 'text-warning',
  critical: 'text-destructive'
}

const DOT_TONE = { normal: 'ok', warning: 'warning', critical: 'critical' } as const

const spoken = (r: UsageReading): string =>
  `${r.label.charAt(0).toLowerCase()}${r.label.slice(1)} ${r.percent}% used`

/** Composer chip for a Claude chat. */
export function ClaudeAccountChip({
  sessionId,
  compact = false
}: {
  sessionId: string
  compact?: boolean
}): React.JSX.Element | null {
  return <AccountChip ctx={useChatClaudeAccount(sessionId)} compact={compact} />
}

/** The same chip before a chat exists (the agent launcher). */
export function ProjectClaudeAccountChip({
  projectId,
  compact = false
}: {
  projectId: string
  compact?: boolean
}): React.JSX.Element | null {
  return <AccountChip ctx={useProjectClaudeAccount(projectId)} compact={compact} />
}

/**
 * Which Account the Project uses and how much of its 5-hour window is used,
 * plus any other window near its limit. The menu switches the Project's
 * Account; open Claude chats of the Project restart on it.
 */
function AccountChip({
  ctx,
  compact
}: {
  ctx: (ProjectClaudeAccount & Partial<Pick<ChatClaudeAccount, 'rateLimit'>>) | null
  compact: boolean
}): React.JSX.Element | null {
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const [switching, setSwitching] = useState(false)
  if (!ctx) return null

  const used = fiveHourUsage(ctx.current.usage, ctx.rateLimit ?? null)
  const segments = used
    ? [used.main, ...(used.other && used.other.tone !== 'normal' ? [used.other] : [])]
    : []
  const tone = usageTone(Math.max(0, ...segments.map((s) => s.percent)))
  const signedOut = accountReadiness(ctx.current.account, ctx.current.usage) !== 'ready'
  const snapshot = ctx.accounts.snapshot

  const choose = async (accountId: string | null): Promise<void> => {
    const nextId = accountId ?? snapshot?.defaultAccountId ?? null
    const next = snapshot?.accounts.find((a) => a.id === nextId)
    if (accountId === (ctx.explicit ? ctx.current.account.id : null)) return
    setSwitching(true)
    try {
      await switchProjectClaudeAccount(ctx.projectId, accountId)
      await ctx.accounts.reload()
      toast.success(next ? `This project now uses ${next.name}` : 'Account changed')
    } catch (err) {
      toastAccountChoiceError(err, 'Could not switch the account')
      void ctx.accounts.reload()
    } finally {
      setSwitching(false)
    }
  }

  const row = (
    choiceId: string | null,
    label: string,
    sub: string,
    selected: boolean,
    readiness: AccountReadiness
  ) => (
    <DropdownMenuItem
      key={choiceId ?? 'follow-default'}
      disabled={readiness !== 'ready'}
      onSelect={() => void choose(choiceId)}
      className="flex items-center gap-2"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-foreground">{label}</span>
        <span className="truncate text-2xs text-muted-foreground">{sub}</span>
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {selected && <Check size={14} />}
      </span>
    </DropdownMenuItem>
  )

  const readinessOf = (account: AccountChoice['account']): AccountReadiness =>
    accountReadiness(account, ctx.accounts.usage[account.id])

  const describe = (account: AccountChoice['account']): string => {
    const readiness = readinessOf(account)
    if (readiness !== 'ready')
      return `${NOT_READY_REASON[readiness]} · sign in from Manage accounts`
    const usage = ctx.accounts.usage[account.id]
    const windows = fiveHourUsage(usage, null)
    const readings = [windows?.main, windows?.other].flatMap((r) =>
      r ? [`${r.label} ${r.percent}%`] : []
    )
    return (
      [planLabel(usage?.subscriptionType ?? null), ...readings].filter(Boolean).join(' · ') ||
      'Signed in'
    )
  }

  const name = ctx.current.account.name
  const defaultReadiness = ctx.defaultAccount ? readinessOf(ctx.defaultAccount) : 'ready'
  const defaultState =
    defaultReadiness === 'ready' ? '' : ` · ${NOT_READY_REASON[defaultReadiness].toLowerCase()}`
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return
        void ctx.accounts.reload()
        void ctx.accounts.refreshUsage(false)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          aria-busy={switching}
          className={cn(
            'relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors ease-out',
            "after:absolute after:-inset-1 after:content-['']",
            'hover:text-foreground data-[state=open]:text-foreground disabled:opacity-60'
          )}
          aria-label={`Claude account: ${[name, ...segments.map(spoken)].join(', ')}. Change account`}
        >
          {switching ? (
            <Spinner size={10} decorative />
          ) : (
            <StatusDot tone={signedOut ? 'signed-out' : DOT_TONE[tone]} />
          )}
          {!compact && <span className="max-w-24 truncate">{name}</span>}
          {!signedOut &&
            segments.map((segment, i) => (
              <span key={segment.short} className="flex items-center gap-1.5 tabular-nums">
                {i > 0 && <span aria-hidden>·</span>}
                <span className={TONE_TEXT[segment.tone]}>
                  {segment.short} {segment.percent}%
                </span>
              </span>
            ))}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Account for this project</DropdownMenuLabel>
        {ctx.defaultAccount &&
          row(
            null,
            'Follow default',
            `Uses ${ctx.defaultAccount.name}${defaultState}`,
            !ctx.explicit,
            defaultReadiness
          )}
        {(snapshot?.accounts ?? []).map((account) =>
          row(
            account.id,
            account.name,
            describe(account),
            ctx.explicit && account.id === ctx.current.account.id,
            readinessOf(account)
          )
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => openAppSettings('provider')}
          className="flex items-center gap-2"
        >
          <span className="flex-1 text-xs">Manage accounts</span>
          <ExternalLink size={12} className="text-muted-foreground" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
