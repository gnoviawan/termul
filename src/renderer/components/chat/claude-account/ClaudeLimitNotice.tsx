import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
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
import { formatUsageReset } from '@/lib/claude-usage-format'
import { logFrontendError } from '@/lib/log-api'
import { restartClaudeSession, switchProjectClaudeAccount } from '@/stores/claude-account-switch'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { type AccountChoice, useChatClaudeAccount } from './use-chat-claude-account'

/** Grace after a reset time before the prompt is sent again. */
const RESUME_GRACE_MS = 15_000

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly'
}

const windowName = (limit: ClaudeRateLimit): string =>
  (limit.kind && WINDOW_NAMES[limit.kind]) || 'usage'

/** "Continue when it resets" timers, by chat, kept outside the panel so a tab switch keeps them. */
interface ResumeState {
  at: Record<string, number>
  timers: Record<string, ReturnType<typeof setTimeout>>
  schedule: (sessionId: string, at: number) => void
  cancel: (sessionId: string) => void
}

export const useClaudeResumeStore = create<ResumeState>((set, get) => ({
  at: {},
  timers: {},
  schedule: (sessionId, at) => {
    get().cancel(sessionId)
    const timer = setTimeout(
      () => {
        set((s) => {
          const { [sessionId]: _a, ...at } = s.at
          const { [sessionId]: _t, ...timers } = s.timers
          return { at, timers }
        })
        void logFrontendError({
          level: 'info',
          source: 'claudeLimit.resume',
          message: `Limit window reset; continuing chat ${sessionId}`
        })
        void restartClaudeSession(sessionId, { resend: true, cancelTurn: true })
      },
      Math.max(0, at - Date.now() + RESUME_GRACE_MS)
    )
    set((s) => ({ at: { ...s.at, [sessionId]: at }, timers: { ...s.timers, [sessionId]: timer } }))
  },
  cancel: (sessionId) => {
    const timer = get().timers[sessionId]
    if (timer) clearTimeout(timer)
    set((s) => {
      const { [sessionId]: _a, ...at } = s.at
      const { [sessionId]: _t, ...timers } = s.timers
      return { at, timers }
    })
  }
}))

const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Dismissed notices, by chat and reset time, so a new window shows again. */
const dismissed = new Set<string>()

/**
 * In-chat notice for a Claude chat near or at its Account's limit: a calm
 * warning from 80%, and at the limit the offer to switch to the Account with
 * the most room and continue (or to continue when the window resets).
 */
export function ClaudeLimitNotice({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const ctx = useChatClaudeAccount(sessionId)
  const openAppSettings = useSettingsModalStore((s) => s.openApp)
  const scheduledAt = useClaudeResumeStore((s) => s.at[sessionId] ?? null)
  const schedule = useClaudeResumeStore((s) => s.schedule)
  const cancelResume = useClaudeResumeStore((s) => s.cancel)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [, rerender] = useState(0)
  if (!ctx?.rateLimit) return null

  const limit = ctx.rateLimit
  const key = `${sessionId}:${limit.status}:${limit.resetsAt ?? ''}`
  if (dismissed.has(key)) return null
  const dismiss = (): void => {
    dismissed.add(key)
    rerender((n) => n + 1)
  }
  const name = ctx.current.account.name
  const reset = formatUsageReset(limit.resetsAt)

  const projectId = ctx.projectId
  const reloadAccounts = ctx.accounts.reload
  async function switchTo(target: AccountChoice): Promise<void> {
    setSwitchingTo(target.account.id)
    cancelResume(sessionId)
    try {
      await switchProjectClaudeAccount(projectId, target.account.id, {
        continueSessionId: limit.status === 'rejected' ? sessionId : undefined
      })
      await reloadAccounts()
      toast.success(`Switched to ${target.account.name}`)
    } catch (err) {
      toast.error(`Could not switch: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSwitchingTo(null)
    }
  }

  if (
    limit.status === 'allowed_warning' ||
    (limit.status === 'allowed' && (limit.percent ?? 0) >= 80)
  ) {
    const best = ctx.alternatives[0]
    return (
      <div
        role="status"
        className="mb-2 flex items-center gap-2 rounded-md bg-warning/10 px-3 py-1.5 text-2xs text-warning"
      >
        <AlertCircle size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {name} has used {Math.round(limit.percent ?? 80)}% of its {windowName(limit)} limit
          {reset ? ` · ${reset}` : ''}.
        </span>
        {best && (
          <button
            type="button"
            onClick={() => void switchTo(best)}
            className="shrink-0 font-medium underline-offset-2 hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
          >
            Switch to {best.account.name}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded text-warning/80 hover:text-warning focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  if (limit.status !== 'rejected' || limit.overageInUse) return null

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
              <Button type="button" size="xs" variant="ghost" onClick={() => openAppSettings()}>
                Add account
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
