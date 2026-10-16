import type {
  ClaudeAccountUsage,
  ClaudeAccountView,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Check, ExternalLink, Info, Link2, Shuffle } from '@/components/icons'
import { Button } from '@/components/ui/button'
import type { ProjectClaudeAccountDraft } from '@/hooks/use-project-claude-account-draft'
import { claudeAccountsApi, isClaudeLoginCancelled } from '@/lib/claude-accounts-api'
import { formatUsageReset, usageTone, usageWindowLabel } from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'
import { accountStatus, PERCENT_TEXT, StatusDot, UsageBar } from './account-status'
import { AccountAvatar, DefaultPill } from './ClaudeAccountRow'
import { oldestCheck, ProviderGroupHeader } from './ProviderGroupHeader'

/** Option id for "Follow default"; Account ids are hex, so it cannot collide. */
const FOLLOW_DEFAULT = 'follow-default'

function CompactUsage({
  usage,
  window,
  signedOut
}: {
  usage: ClaudeAccountUsage | undefined
  window: ClaudeUsageWindow | null
  signedOut: boolean
}): React.JSX.Element {
  if (signedOut) return <span className="text-2xs text-warning">Sign in to see usage</span>
  if (!usage) {
    return (
      <span className="flex w-full flex-col items-end gap-1.5" aria-hidden="true">
        <span className="h-2 w-16 rounded bg-muted" />
        <span className="h-1 w-full rounded-full bg-muted" />
      </span>
    )
  }
  if (!window) {
    return (
      <span className="text-2xs text-muted-foreground">
        {usage.status === 'error' ? 'Usage not available' : 'No usage yet'}
      </span>
    )
  }
  const tone = usageTone(window.percent)
  const label = usageWindowLabel(window)
  return (
    <span className="flex w-full flex-col items-end gap-1.5">
      <span className="flex gap-1.5 text-2xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-semibold tabular-nums', PERCENT_TEXT[tone])}>
          {Math.round(window.percent)}%
        </span>
      </span>
      <UsageBar
        window={window}
        label={`${label} usage`}
        valueText={`${Math.round(window.percent)}% used`}
      />
    </span>
  )
}

interface OptionProps {
  id: string
  selected: boolean
  onSelect: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  leading: React.ReactNode
  title: React.ReactNode
  sub: React.ReactNode
  trailing: React.ReactNode
}

function Option({ id, selected, onSelect, onKeyDown, leading, title, sub, trailing }: OptionProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      data-option
      className={cn(
        'grid cursor-default grid-cols-[1.75rem_minmax(0,1fr)_1rem] items-center gap-x-3.5 gap-y-2 rounded-lg px-3 py-2.5 outline-hidden transition-colors @[34rem]:grid-cols-[1.75rem_minmax(0,1fr)_10.5rem_1rem]',
        'focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.12]'
          : 'hover:bg-foreground/[0.02]'
      )}
    >
      {leading}
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
          {title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {sub}
        </span>
      </span>
      <span className="col-span-3 col-start-1 row-start-2 flex justify-end pl-[3.125rem] @[34rem]:col-span-1 @[34rem]:col-start-3 @[34rem]:row-start-1 @[34rem]:pl-0">
        {trailing}
      </span>
      <span className="col-start-3 row-start-1 flex justify-center text-foreground @[34rem]:col-start-4">
        {selected && <Check size={15} />}
      </span>
    </div>
  )
}

interface ProjectProviderSettingsProps {
  claude: ProjectClaudeAccountDraft
  /** The user changed a choice (marks the Project Settings form dirty). */
  onChange: () => void
  /** Open Settings → Provider to add or sign in to accounts. */
  onManageAccounts: () => void
}

/**
 * Project Settings → Provider: one pick-one list per provider ("Follow
 * default" first, then each Account), and the one action that fixes a problem
 * with the chosen Account. Claude Code is the first provider.
 */
export function ProjectProviderSettings({
  claude,
  onChange,
  onManageAccounts
}: ProjectProviderSettingsProps): React.JSX.Element {
  const { snapshot, usage, loading, error, refreshingUsage, reload, refreshUsage } = claude.accounts
  const listRef = useRef<HTMLDivElement>(null)
  const [signingIn, setSigningIn] = useState(false)

  const choose = (accountId: string | null): void => {
    if (accountId === claude.value) return
    claude.setValue(accountId)
    onChange()
  }

  const onOptionKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    accountId: string | null
  ) => {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-option]') ?? []
    )
    const index = options.indexOf(event.currentTarget)
    const focusAt = (next: number) => options[(next + options.length) % options.length]?.focus()
    if (event.key === 'ArrowDown') focusAt(index + 1)
    else if (event.key === 'ArrowUp') focusAt(index - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(options.length - 1)
    else if (event.key === 'Enter' || event.key === ' ') choose(accountId)
    else return
    event.preventDefault()
  }

  const header = (
    <ProviderGroupHeader
      iconKey="acp:claude-acp"
      name="Claude Code"
      lastChecked={snapshot ? oldestCheck(usage) : null}
      refreshing={refreshingUsage}
      onRefresh={snapshot ? () => void refreshUsage(true) : undefined}
      action={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={onManageAccounts}
          className="text-secondary-foreground"
        >
          Manage accounts
          <ExternalLink size={12} />
        </Button>
      }
    />
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className="flex flex-col gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3.5 px-3 py-2.5">
              <span className="size-7 rounded-full bg-muted" />
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="h-2 w-24 rounded bg-muted" />
                <span className="h-1.5 w-36 rounded bg-muted" />
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error || !snapshot) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <div className="flex items-center justify-between gap-3 py-2 text-xs">
          <span className="text-muted-foreground">
            Claude accounts are not available right now{error ? `: ${error}` : '.'}
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const defaultAccount = snapshot.accounts.find((a) => a.id === snapshot.defaultAccountId) ?? null
  const effective =
    snapshot.accounts.find((a) => a.id === (claude.value ?? snapshot.defaultAccountId)) ??
    defaultAccount
  const statusOf = (account: ClaudeAccountView) => accountStatus(account, usage[account.id])
  const effectiveStatus = effective ? statusOf(effective) : null

  const alternative =
    effectiveStatus?.tone === 'critical'
      ? snapshot.accounts
          .filter((a) => a.id !== effective?.id && statusOf(a).tone === 'ok')
          .map((a) => ({ account: a, percent: statusOf(a).primary?.percent ?? 0 }))
          .sort((x, y) => x.percent - y.percent)[0]
      : undefined

  const signInEffective = async (): Promise<void> => {
    if (!effective) return
    setSigningIn(true)
    try {
      await claudeAccountsApi.login(effective.id)
      toast.success(`${effective.name} is signed in`)
      await reload()
      await refreshUsage(true)
    } catch (err) {
      if (!isClaudeLoginCancelled(err)) {
        toast.error(`Sign-in did not finish: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      setSigningIn(false)
    }
  }

  const defaultStatus = defaultAccount ? statusOf(defaultAccount) : null

  return (
    <div className="flex flex-col gap-3">
      {header}

      <div
        ref={listRef}
        role="listbox"
        aria-label="Claude account for this project"
        className="@container flex flex-col gap-0.5"
      >
        <Option
          id={`claude-option-${FOLLOW_DEFAULT}`}
          selected={claude.value === null}
          onSelect={() => choose(null)}
          onKeyDown={(event) => onOptionKeyDown(event, null)}
          leading={
            <span
              aria-hidden="true"
              className="flex size-7 items-center justify-center rounded-lg bg-muted text-secondary-foreground"
            >
              <Link2 size={14} />
            </span>
          }
          title="Follow default"
          sub={
            <span className="truncate">
              {defaultAccount ? `Uses ${defaultAccount.name} now. ` : ''}Changes when you change the
              default.
            </span>
          }
          trailing={
            defaultAccount && (
              <CompactUsage
                usage={usage[defaultAccount.id]}
                window={defaultStatus?.primary ?? null}
                signedOut={defaultStatus?.tone === 'signed-out'}
              />
            )
          }
        />
        {snapshot.accounts.map((account) => {
          const status = statusOf(account)
          return (
            <Option
              key={account.id}
              id={`claude-option-${account.id}`}
              selected={claude.value === account.id}
              onSelect={() => choose(account.id)}
              onKeyDown={(event) => onOptionKeyDown(event, account.id)}
              leading={<AccountAvatar name={account.name} />}
              title={
                <>
                  <span className="truncate">{account.name}</span>
                  {account.id === snapshot.defaultAccountId && <DefaultPill />}
                </>
              }
              sub={
                <>
                  <StatusDot tone={status.tone} />
                  <span className="truncate">
                    {status.tone !== 'ok'
                      ? status.meta
                      : status.meta === 'Signed in'
                        ? 'Signed in'
                        : `${status.meta} · signed in`}
                  </span>
                </>
              }
              trailing={
                <CompactUsage
                  usage={usage[account.id]}
                  window={status.primary}
                  signedOut={status.tone === 'signed-out'}
                />
              }
            />
          )
        })}
      </div>

      {effective && effectiveStatus?.tone === 'signed-out' && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-warning/25 bg-warning/[0.07] px-3.5 py-3"
        >
          <AlertCircle size={15} className="shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-warning">{effective.name} is signed out</span>
            <span className="text-2xs text-muted-foreground">
              New Claude chats in this project cannot start until you sign in again.
            </span>
          </div>
          {claudeAccountsApi.canManageAccounts() ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void signInEffective()}
              disabled={signingIn}
            >
              {signingIn ? 'Waiting…' : 'Sign in'}
            </Button>
          ) : (
            <Button type="button" size="xs" variant="outline" onClick={onManageAccounts}>
              Open settings
            </Button>
          )}
        </div>
      )}

      {effective && effectiveStatus?.tone === 'critical' && effectiveStatus.primary && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/[0.07] px-3.5 py-3"
        >
          <AlertCircle size={15} className="shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-destructive">
              {effective.name} reached its {usageWindowLabel(effectiveStatus.primary)} limit
            </span>
            <span className="text-2xs text-muted-foreground">
              {formatUsageReset(effectiveStatus.primary.resetsAt) ?? 'Resets soon'}.
              {alternative
                ? ` ${alternative.account.name} has the most room left (${Math.round(alternative.percent)}% used).`
                : ' No other account has room left right now.'}
            </span>
          </div>
          {alternative && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => choose(alternative.account.id)}
            >
              <Shuffle />
              Use {alternative.account.name}
            </Button>
          )}
        </div>
      )}

      <p className="flex items-center gap-1.5 px-3 text-2xs text-muted-foreground">
        <Info size={12} className="shrink-0" />
        New Claude Agent chats here use this account. Open chats switch when they start again.
      </p>

      <p className="mt-1 border-t border-border/60 px-3 pt-3 text-2xs text-muted-foreground">
        Other providers get their own group here when they support accounts.
      </p>
    </div>
  )
}
