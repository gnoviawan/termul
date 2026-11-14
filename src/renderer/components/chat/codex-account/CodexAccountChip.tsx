import { useState } from 'react'
import { toast } from 'sonner'
import { Check, ExternalLink } from '@/components/icons'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { StatusDot } from '@/components/settings/provider/account-status'
import {
  CODEX_NOT_READY_REASON,
  codexAccountReadiness
} from '@/components/settings/provider/codex-account-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { switchProjectCodexAccount } from '@/stores/codex-account-switch'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useChatCodexAccount } from './use-chat-codex-account'
import { type ProjectCodexAccount, useProjectCodexAccount } from './use-project-codex-account'

/** Composer chip for a Codex chat. */
export function CodexAccountChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  return <AccountChip ctx={useChatCodexAccount(sessionId)} />
}

/** The same chip before a chat exists (the agent launcher). */
export function ProjectCodexAccountChip({
  projectId
}: {
  projectId: string
}): React.JSX.Element | null {
  return <AccountChip ctx={useProjectCodexAccount(projectId)} />
}

function AccountChip({ ctx }: { ctx: ProjectCodexAccount | null }): React.JSX.Element | null {
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const [switching, setSwitching] = useState(false)
  if (!ctx) return null

  const readiness = codexAccountReadiness(ctx.current)
  const signedOut = readiness !== 'ready'
  const snapshot = ctx.accounts.snapshot

  const choose = async (accountId: string | null): Promise<void> => {
    const nextId = accountId ?? snapshot?.defaultAccountId ?? null
    const next = snapshot?.accounts.find((a) => a.id === nextId)
    if (accountId === (ctx.explicit ? ctx.current.id : null)) return
    setSwitching(true)
    try {
      await switchProjectCodexAccount(ctx.projectId, accountId)
      await ctx.accounts.reload()
      toast.success(next ? `This project now uses ${next.name}` : 'Account changed')
    } catch (err) {
      toastAccountChoiceError(err, 'Could not switch the account')
      void ctx.accounts.reload()
    } finally {
      setSwitching(false)
    }
  }

  const name = ctx.current.name
  const defaultReadiness = ctx.defaultAccount ? codexAccountReadiness(ctx.defaultAccount) : 'ready'

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void ctx.accounts.reload()
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          aria-busy={switching}
          data-testid="codex-account-chip"
          className={cn(
            'relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-2xs text-muted-foreground transition-colors ease-out',
            "after:absolute after:-inset-1 after:content-['']",
            'hover:text-foreground data-[state=open]:text-foreground disabled:opacity-60'
          )}
          aria-label={`Codex account: ${name}. Change account`}
        >
          {switching ? (
            <Spinner size={10} decorative />
          ) : (
            <StatusDot tone={signedOut ? 'signed-out' : 'ok'} />
          )}
          <span className="max-w-24 truncate">{name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Codex account for this project</DropdownMenuLabel>
        {ctx.defaultAccount && (
          <DropdownMenuItem
            disabled={defaultReadiness !== 'ready'}
            onSelect={() => void choose(null)}
            className="flex items-center gap-2"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs text-foreground">Follow default</span>
              <span className="truncate text-2xs text-muted-foreground">
                Uses {ctx.defaultAccount.name}
                {defaultReadiness === 'ready'
                  ? ''
                  : ` · ${CODEX_NOT_READY_REASON[defaultReadiness].toLowerCase()}`}
              </span>
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {!ctx.explicit && <Check size={14} />}
            </span>
          </DropdownMenuItem>
        )}
        {(snapshot?.accounts ?? []).map((account) => {
          const rowReady = codexAccountReadiness(account)
          return (
            <DropdownMenuItem
              key={account.id}
              disabled={rowReady !== 'ready'}
              onSelect={() => void choose(account.id)}
              className="flex items-center gap-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs text-foreground">{account.name}</span>
                <span className="truncate text-2xs text-muted-foreground">
                  {rowReady === 'ready' ? 'Signed in' : CODEX_NOT_READY_REASON[rowReady]}
                </span>
              </span>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {ctx.explicit && account.id === ctx.current.id && <Check size={14} />}
              </span>
            </DropdownMenuItem>
          )
        })}
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
