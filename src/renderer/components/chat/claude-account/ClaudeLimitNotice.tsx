import { AlertCircle, ChevronDown, Clock, Shuffle, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { isAtLimit, useClaudeLimit, useClaudeResumeStore, windowName } from './use-claude-limit'

const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * In-chat card for a Claude chat at its Account's limit: the offer to switch
 * to the Account with the most room and continue (or to continue when the
 * window resets). The near-limit warning is `ClaudeLimitWarning`, in the composer.
 */
export function ClaudeLimitNotice({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useClaudeLimit(sessionId)
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const scheduledAt = useClaudeResumeStore((s) => s.at[sessionId] ?? null)
  const schedule = useClaudeResumeStore((s) => s.schedule)
  const cancelResume = useClaudeResumeStore((s) => s.cancel)
  if (!state || !isAtLimit(state.limit)) return null

  const { ctx, limit, name, reset, switchTo, switchingTo, dismiss } = state
  const [best, ...others] = ctx.alternatives
  const switching = switchingTo
    ? ctx.alternatives.find((c) => c.account.id === switchingTo)?.account.name
    : null

  return (
    <div
      role="alert"
      className="mb-2 flex flex-col gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.06] p-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle size={15} className="mt-0.5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-medium text-destructive">
            {name} reached its {windowName(limit)} limit
          </span>
          <span className="text-2xs text-muted-foreground">
            {reset ? `${reset[0].toUpperCase()}${reset.slice(1)}.` : 'It resets soon.'}{' '}
            {best
              ? `Switch to ${best.account.name}${best.window ? ` (${Math.round(best.window.percent)}% used)` : ''} and continue?`
              : 'No other account has room left right now.'}
          </span>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-[1.5625rem]">
        {switching ? (
          <span className="flex items-center gap-2 text-2xs text-secondary-foreground">
            <Spinner size={12} decorative />
            Switching to {switching} and continuing…
          </span>
        ) : best ? (
          <>
            <Button type="button" size="xs" onClick={() => void switchTo(best)}>
              <Shuffle />
              Switch to {best.account.name} and continue
            </Button>
            {others.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="xs" variant="ghost">
                    Other account
                    <ChevronDown size={12} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {others.map((choice) => (
                    <DropdownMenuItem
                      key={choice.account.id}
                      onSelect={() => void switchTo(choice)}
                    >
                      {choice.account.name}
                      {choice.window ? ` · ${Math.round(choice.window.percent)}% used` : ''}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ) : scheduledAt ? (
          <span className="flex items-center gap-2 text-2xs text-secondary-foreground">
            <Clock size={12} />
            Continues at {formatClock(scheduledAt)}
            <button
              type="button"
              onClick={() => cancelResume(sessionId)}
              className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            >
              Cancel
            </button>
          </span>
        ) : (
          <>
            {limit.resetsAt !== null && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => schedule(sessionId, (limit.resetsAt ?? 0) * 1000)}
              >
                <Clock />
                Continue when it resets
              </Button>
            )}
            {claudeAccountsApi.canManageAccounts() && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => openAppSettings('provider')}
              >
                Add account
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
