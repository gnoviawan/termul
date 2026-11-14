import type { CodexAccountView } from '@shared/types/codex-accounts.types'
import { useState } from 'react'
import { Check, ExternalLink } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import type { ProjectCodexAccountDraft } from '@/hooks/use-project-codex-account-draft'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'
import { AccountAvatar, DefaultPill } from './ClaudeAccountRow'
import { CodexSignInDialog } from './CodexSignInDialog'
import { CODEX_NOT_READY_REASON, codexAccountReadiness } from './codex-account-status'
import { ProviderGroupHeader } from './ProviderGroupHeader'

interface CodexProjectAccountSettingsProps {
  codex: ProjectCodexAccountDraft
  onChange: () => void
  onManageAccounts: () => void
}

/**
 * Project settings → Accounts: pick the Codex Account for this Project, or
 * follow the default. A signed-out Account cannot be chosen.
 */
export function CodexProjectAccountSettings({
  codex,
  onChange,
  onManageAccounts
}: CodexProjectAccountSettingsProps): React.JSX.Element {
  const { snapshot, loading, error, reload, refreshUsage } = codex.accounts
  const canManage = useServerAdmitsRemoteWrites()
  const [signingIn, setSigningIn] = useState<CodexAccountView | null>(null)
  const accounts = snapshot?.accounts ?? []
  const failed = !loading && (error !== null || !snapshot)

  const readinessOf = (accountId: string | null) => {
    const account = accounts.find((a) => a.id === (accountId ?? snapshot?.defaultAccountId))
    return account ? codexAccountReadiness(account) : 'unconfirmed'
  }

  const choose = (accountId: string | null): void => {
    if (!canManage || accountId === codex.value || readinessOf(accountId) !== 'ready') return
    codex.setValue(accountId)
    onChange()
  }

  const selected = (accountId: string | null): boolean => codex.value === accountId

  return (
    <div className="mt-6 flex flex-col gap-2" data-testid="codex-project-accounts">
      <ProviderGroupHeader
        iconKey="acp:codex-acp"
        name="Codex"
        lastChecked={null}
        refreshing={false}
        action={
          <Button type="button" size="xs" variant="outline" onClick={onManageAccounts}>
            Manage accounts
            <ExternalLink size={12} />
          </Button>
        }
      />
      {loading && <p className="py-3 text-xs text-muted-foreground">Loading Codex accounts…</p>}
      {failed && (
        <p className="py-3 text-xs text-muted-foreground">
          {error ?? 'Codex accounts are not available right now.'}
        </p>
      )}
      {!loading && snapshot && (
        <div
          className="flex flex-col gap-1"
          role="listbox"
          aria-label="Codex account for this project"
        >
          <OptionRow
            label="Follow default"
            sub={
              snapshot.accounts.find((a) => a.id === snapshot.defaultAccountId)?.name
                ? `Uses ${snapshot.accounts.find((a) => a.id === snapshot.defaultAccountId)?.name}`
                : 'Uses the default account'
            }
            selected={selected(null)}
            disabled={!canManage || readinessOf(null) !== 'ready'}
            onSelect={() => choose(null)}
          />
          {accounts.map((account) => {
            const readiness = codexAccountReadiness(account)
            return (
              <OptionRow
                key={account.id}
                label={account.name}
                sub={
                  readiness === 'ready'
                    ? account.builtin
                      ? 'Host Codex home'
                      : 'Signed in'
                    : CODEX_NOT_READY_REASON[readiness]
                }
                selected={selected(account.id)}
                disabled={!canManage || readiness !== 'ready'}
                badge={account.id === snapshot.defaultAccountId}
                onSelect={() => choose(account.id)}
                onSignIn={
                  canManage && readiness !== 'ready' ? () => setSigningIn(account) : undefined
                }
              />
            )
          })}
        </div>
      )}
      <CodexSignInDialog
        account={signingIn}
        onClose={() => setSigningIn(null)}
        onSignedIn={async () => {
          setSigningIn(null)
          await reload()
          await refreshUsage(true)
        }}
      />
    </div>
  )
}

function OptionRow({
  label,
  sub,
  selected,
  disabled,
  badge,
  onSelect,
  onSignIn
}: {
  label: string
  sub: string
  selected: boolean
  disabled: boolean
  badge?: boolean
  onSelect: () => void
  onSignIn?: () => void
}): React.JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={(event) => {
        if (disabled) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 outline-hidden',
        FOCUS_RING_CLASS,
        selected && 'bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.12]',
        !disabled && !selected && 'hover:bg-foreground/[0.02]',
        disabled && 'opacity-60'
      )}
    >
      <AccountAvatar name={label} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <span className="truncate">{label}</span>
          {badge && <DefaultPill />}
        </span>
        <span className="truncate text-2xs text-muted-foreground">{sub}</span>
      </span>
      {onSignIn && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={(event) => {
            event.stopPropagation()
            onSignIn()
          }}
        >
          Sign in
        </Button>
      )}
      <span className="flex size-4 items-center justify-center text-foreground">
        {selected && <Check size={15} />}
      </span>
    </div>
  )
}
