import type {
  ClaudeAccountUsage,
  ClaudeAccountView,
  ClaudeUsageWindow
} from '@shared/types/claude-accounts.types'
import { AlertCircle, ChevronDown } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  formatUsageChecked,
  formatUsageReset,
  usageTone,
  usageWindowLabel
} from '@/lib/claude-usage-format'
import { cn } from '@/lib/utils'
import { accountStatus, PERCENT_TEXT, StatusDot, UsageBar } from './account-status'

/** Whether a row should read as signed out (the CLI probe or the usage read). */
export function isAccountSignedOut(
  account: ClaudeAccountView,
  usage: ClaudeAccountUsage | undefined
): boolean {
  return account.signedIn === false || usage?.status === 'signed_out'
}

export function AccountAvatar({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold uppercase text-secondary-foreground ring-1 ring-inset ring-foreground/10"
    >
      {name.charAt(0)}
    </span>
  )
}

export function DefaultPill(): React.JSX.Element {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-3xs font-medium leading-none text-secondary-foreground">
      Default
    </span>
  )
}

function windowValueText(window: ClaudeUsageWindow): string {
  const reset = formatUsageReset(window.resetsAt)
  return reset
    ? `${Math.round(window.percent)}% used, ${reset}`
    : `${Math.round(window.percent)}% used`
}

function MainMeter({
  window,
  expandable,
  expanded
}: {
  window: ClaudeUsageWindow
  expandable: boolean
  expanded: boolean
}): React.JSX.Element {
  const tone = usageTone(window.percent)
  const label = usageWindowLabel(window)
  const reset = formatUsageReset(window.resetsAt)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-baseline gap-1.5 text-2xs">
        <span
          className={cn(
            'truncate font-medium',
            tone === 'critical' ? 'text-destructive' : 'text-secondary-foreground'
          )}
        >
          {tone === 'critical' ? `${label} limit reached` : label}
        </span>
        <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">
          <span className={PERCENT_TEXT[tone]}>{Math.round(window.percent)}%</span>
        </span>
        {reset && <span className="shrink-0 text-muted-foreground">{reset}</span>}
        {expandable && (
          <ChevronDown
            size={12}
            aria-hidden="true"
            className={cn(
              'shrink-0 self-center text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              expanded && 'rotate-180'
            )}
          />
        )}
      </div>
      <UsageBar window={window} label={`${label} usage`} valueText={windowValueText(window)} />
    </div>
  )
}

function OtherWindows({ windows }: { windows: ClaudeUsageWindow[] }): React.JSX.Element {
  return (
    <div className="flex flex-col items-end gap-1 text-2xs">
      {windows.map((window) => (
        <span key={`${window.kind}:${window.scope ?? ''}`} className="flex gap-1.5">
          <span className="text-muted-foreground">
            {window.kind === 'weekly_scoped' && window.scope
              ? window.scope
              : usageWindowLabel(window)}
          </span>
          <span
            className={cn(
              'font-medium tabular-nums',
              usageTone(window.percent) === 'normal'
                ? 'text-secondary-foreground'
                : PERCENT_TEXT[usageTone(window.percent)]
            )}
          >
            {Math.round(window.percent)}%
          </span>
        </span>
      ))}
    </div>
  )
}

function Detail({
  usage,
  projectNames
}: {
  usage: ClaudeAccountUsage
  projectNames: string[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 pb-4 pl-[2.375rem]">
      {usage.windows.map((window) => {
        const reset = formatUsageReset(window.resetsAt)
        return (
          <div
            key={`${window.kind}:${window.scope ?? ''}`}
            className="grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-x-3 gap-y-1 text-2xs @[34rem]:grid-cols-[10.5rem_minmax(0,1fr)_2.25rem_8rem]"
          >
            <span className="col-span-2 font-medium text-secondary-foreground @[34rem]:col-span-1">
              {window.kind === 'session' ? '5-hour session' : usageWindowLabel(window)}
            </span>
            <UsageBar
              window={window}
              label={`${usageWindowLabel(window)} usage`}
              valueText={windowValueText(window)}
            />
            <span
              className={cn(
                'text-right font-semibold tabular-nums',
                PERCENT_TEXT[usageTone(window.percent)]
              )}
            >
              {Math.round(window.percent)}%
            </span>
            <span className="col-span-2 text-muted-foreground @[34rem]:col-span-1">
              {reset ?? 'not started'}
            </span>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-2xs text-muted-foreground">
        {projectNames.length > 0 && <span>Used by: {projectNames.join(', ')}</span>}
        <span>{formatUsageChecked(usage.checkedAt)}</span>
      </div>
    </div>
  )
}

export interface ClaudeAccountRowProps {
  account: ClaudeAccountView
  usage: ClaudeAccountUsage | undefined
  isDefault: boolean
  /** Names of the Projects that chose this Account explicitly. */
  projectNames: string[]
  signingIn: boolean
  expanded: boolean
  canManage: boolean
  onToggle: () => void
  onSignIn: () => void
  onCancelSignIn: () => void
  onRetryUsage: () => void
  /** The ⋯ menu. */
  menu: React.ReactNode
}

/**
 * Settings → Provider row: identity, the main meter (the most used window),
 * the other windows as chips, and the ⋯ menu, on fixed columns so every row
 * lines up. Below 40rem the meter moves under the name.
 */
export function ClaudeAccountRow({
  account,
  usage,
  isDefault,
  projectNames,
  signingIn,
  expanded,
  canManage,
  onToggle,
  onSignIn,
  onCancelSignIn,
  onRetryUsage,
  menu
}: ClaudeAccountRowProps): React.JSX.Element {
  const status = accountStatus(account, usage, { signingIn, projectCount: projectNames.length })
  const others = status.primary
    ? (usage?.windows ?? []).filter((window) => window !== status.primary)
    : []
  const canExpand = usage?.status === 'ok' && usage.windows.length > 0 && !signingIn
  const signedOut = status.tone === 'signed-out'

  let body: React.ReactNode
  let side: React.ReactNode = null
  if (signingIn) {
    body = (
      <span className="flex items-center gap-2 text-xs text-secondary-foreground">
        <Spinner size={13} decorative />
        Finish signing in to {account.name} in your browser…
      </span>
    )
    side = canManage ? (
      <Button type="button" size="xs" variant="ghost" onClick={onCancelSignIn}>
        Cancel
      </Button>
    ) : null
  } else if (signedOut) {
    body = (
      <span className="flex flex-col gap-0.5">
        <span className="text-xs text-secondary-foreground">
          Sign in to use this account and see its limits.
        </span>
        {projectNames.length > 0 && (
          <span className="text-2xs text-muted-foreground">
            Chats in projects that use {account.name} cannot start until then.
          </span>
        )}
      </span>
    )
    side = canManage ? (
      <Button type="button" size="xs" variant="outline" onClick={onSignIn}>
        Sign in
      </Button>
    ) : null
  } else if (!usage) {
    body = (
      <span className="flex flex-col gap-2" aria-hidden="true">
        <span className="h-2 w-2/3 rounded bg-muted" />
        <span className="h-1 w-full rounded-full bg-muted" />
      </span>
    )
  } else if (usage.status === 'error') {
    body = (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <AlertCircle size={13} />
        Usage is not available right now.
        <button
          type="button"
          onClick={onRetryUsage}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          Try again
        </button>
      </span>
    )
  } else if (usage.status === 'unavailable') {
    body = (
      <span className="text-xs text-muted-foreground">This login has no plan limits to show.</span>
    )
  } else if (!status.primary) {
    body = <span className="text-xs text-muted-foreground">No usage yet.</span>
  } else {
    const meter = <MainMeter window={status.primary} expandable={canExpand} expanded={expanded} />
    body = canExpand ? (
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} all limits for ${account.name}`}
        className="-mx-2 -my-1.5 block w-[calc(100%+1rem)] rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        {meter}
      </button>
    ) : (
      meter
    )
    side = others.length > 0 ? <OtherWindows windows={others} /> : null
  }

  return (
    <div
      className="@container border-b border-border/60 last:border-b-0"
      data-testid={`claude-account-${account.id}`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-x-3 gap-y-2.5 py-3.5 @[40rem]:grid-cols-[13.75rem_minmax(0,1fr)_8.25rem_1.75rem] @[40rem]:gap-x-4">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5">
          <AccountAvatar name={account.name} />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">{account.name}</span>
              {isDefault && <DefaultPill />}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <StatusDot tone={status.tone} />
              <span className="truncate text-2xs text-muted-foreground">{status.meta}</span>
            </div>
          </div>
        </div>

        <div className="col-span-3 row-start-2 min-w-0 @[40rem]:col-span-1 @[40rem]:col-start-2 @[40rem]:row-start-1">
          {body}
        </div>

        <div className="col-start-2 row-start-1 flex justify-end @[40rem]:col-start-3">{side}</div>

        <div className="col-start-3 row-start-1 flex justify-center @[40rem]:col-start-4">
          {menu}
        </div>
      </div>
      {expanded && canExpand && usage && <Detail usage={usage} projectNames={projectNames} />}
    </div>
  )
}
