import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import { useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { formatUsageReset } from '@/lib/claude-usage-format'
import { logFrontendError } from '@/lib/log-api'
import { restartClaudeSession, switchProjectClaudeAccount } from '@/stores/claude-account-switch'
import { type ChatClaudeAccount, useChatClaudeAccount } from './use-chat-claude-account'
import type { AccountChoice } from './use-project-claude-account'

/** Grace after a reset time before the prompt is sent again. */
const RESUME_GRACE_MS = 15_000

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly'
}

export const windowName = (limit: ClaudeRateLimit): string =>
  (limit.kind && WINDOW_NAMES[limit.kind]) || 'usage'

/** Near the limit: a calm warning from 80%. */
export const isNearLimit = (limit: ClaudeRateLimit): boolean =>
  limit.status === 'allowed_warning' || (limit.status === 'allowed' && (limit.percent ?? 0) >= 80)

/** At the limit, and no paid overage covers the window. */
export const isAtLimit = (limit: ClaudeRateLimit): boolean =>
  limit.status === 'rejected' && !limit.overageInUse

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

/** Dismissed notices, by chat and reset time, so a new window shows again. */
const dismissed = new Set<string>()

export interface ClaudeLimit {
  ctx: ChatClaudeAccount
  limit: ClaudeRateLimit
  /** The Account the chat uses now. */
  name: string
  /** "resets in 2h 56m", or `null` when Claude sent no reset time. */
  reset: string | null
  dismiss: () => void
  switchTo: (target: AccountChoice) => Promise<void>
  /** Id of the Account a switch is in progress to. */
  switchingTo: string | null
}

/**
 * Live limit state of one Claude chat, shared by the composer warning and the
 * at-limit card. `null` when Claude sent no limit state or the user dismissed it.
 */
export function useClaudeLimit(sessionId: string): ClaudeLimit | null {
  const ctx = useChatClaudeAccount(sessionId)
  const cancelResume = useClaudeResumeStore((s) => s.cancel)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [, rerender] = useState(0)
  if (!ctx?.rateLimit) return null

  const limit = ctx.rateLimit
  const key = `${sessionId}:${limit.status}:${limit.resetsAt ?? ''}`
  if (dismissed.has(key)) return null

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
      toastAccountChoiceError(err, 'Could not switch')
      void reloadAccounts()
    } finally {
      setSwitchingTo(null)
    }
  }

  return {
    ctx,
    limit,
    name: ctx.current.account.name,
    reset: formatUsageReset(limit.resetsAt),
    dismiss: () => {
      dismissed.add(key)
      rerender((n) => n + 1)
    },
    switchTo,
    switchingTo
  }
}
