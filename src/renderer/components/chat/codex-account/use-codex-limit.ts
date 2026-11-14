import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import type { CodexAccountUsage, CodexUsageWindow } from '@shared/types/codex-accounts.types'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { codexResetSeconds, formatUsageReset, primaryCodexWindow } from '@/lib/codex-usage-format'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { restartCodexSession, switchProjectCodexAccount } from '@/stores/codex-account-switch'
import { useChatCodexAccount } from './use-chat-codex-account'
import type { CodexAccountChoice, ProjectCodexAccount } from './use-project-codex-account'

/** Grace after a reset time before the prompt is sent again. */
const RESUME_GRACE_MS = 15_000

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  session: '5-hour',
  weekly: 'weekly'
}

export const windowName = (limit: ClaudeRateLimit): string =>
  (limit.kind && WINDOW_NAMES[limit.kind]) || 'usage'

export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Near the limit: a calm warning from 80%. */
export const isNearLimit = (limit: ClaudeRateLimit): boolean =>
  limit.status === 'allowed_warning' || (limit.status === 'allowed' && (limit.percent ?? 0) >= 80)

/** At the limit. Codex has no paid overage that carries the turn. */
export const isAtLimit = (limit: ClaudeRateLimit): boolean => limit.status === 'rejected'

function kindOf(window: CodexUsageWindow): string {
  return window.kind === 'weekly' ? 'seven_day' : 'five_hour'
}

/** The limit to show: a rejected turn first, else the probe window. */
export function codexDisplayLimit(
  live: ClaudeRateLimit | null,
  usage: CodexAccountUsage | undefined
): ClaudeRateLimit | null {
  const window = primaryCodexWindow(usage)
  if (live?.status === 'rejected') {
    return {
      status: 'rejected',
      resetsAt: live.resetsAt ?? codexResetSeconds(window),
      kind: live.kind ?? (window ? kindOf(window) : null),
      percent: live.percent ?? window?.percent ?? 100,
      overageInUse: false
    }
  }
  if (!window || window.percent < 80) return null
  return {
    status: window.percent >= 100 ? 'rejected' : 'allowed_warning',
    resetsAt: codexResetSeconds(window),
    kind: kindOf(window),
    percent: window.percent,
    overageInUse: false
  }
}

interface ResumeState {
  at: Record<string, number>
  /** `openTurnId` when the resume was scheduled. `null` means the turn had already ended. */
  turns: Record<string, string | null>
  timers: Record<string, ReturnType<typeof setTimeout>>
  schedule: (sessionId: string, at: number) => void
  cancel: (sessionId: string) => void
}

/** A newer turn started after the resume was scheduled. */
function turnReplaced(scheduled: string | null, current: string | null): boolean {
  if (scheduled === null) return current !== null
  return current !== null && current !== scheduled
}

export const useCodexResumeStore = create<ResumeState>((set, get) => ({
  at: {},
  turns: {},
  timers: {},
  schedule: (sessionId, at) => {
    get().cancel(sessionId)
    const sessionAtSchedule = useAcpStore.getState().sessions[sessionId]
    const turnId = sessionAtSchedule?.openTurnId ?? null
    const agentId = sessionAtSchedule?.agentId ?? null
    const timer = setTimeout(
      () => {
        const session = useAcpStore.getState().sessions[sessionId]
        const current = session?.openTurnId ?? null
        // A probe card can schedule this with no session rateLimit. Continue
        // while the same agent and turn are still the ones that were scheduled.
        const sameChat =
          session != null && session.agentId === agentId && !turnReplaced(turnId, current)
        set((state) => {
          const { [sessionId]: _at, ...nextAt } = state.at
          const { [sessionId]: _turn, ...turns } = state.turns
          const { [sessionId]: _timer, ...timers } = state.timers
          return { at: nextAt, turns, timers }
        })
        if (!sameChat) return
        void logFrontendError({
          level: 'info',
          source: 'codexLimit.resume',
          message: `Limit window reset; continuing chat ${sessionId}`
        })
        void restartCodexSession(sessionId, { resend: true, cancelTurn: true })
      },
      Math.max(0, at - Date.now() + RESUME_GRACE_MS)
    )
    set((state) => ({
      at: { ...state.at, [sessionId]: at },
      turns: { ...state.turns, [sessionId]: turnId },
      timers: { ...state.timers, [sessionId]: timer }
    }))
  },
  cancel: (sessionId) => {
    const timer = get().timers[sessionId]
    if (timer) clearTimeout(timer)
    set((state) => {
      const { [sessionId]: _at, ...nextAt } = state.at
      const { [sessionId]: _turn, ...turns } = state.turns
      const { [sessionId]: _timer, ...timers } = state.timers
      return { at: nextAt, turns, timers }
    })
  }
}))

export const useCodexSwitchingStore = create<Record<string, string>>(() => ({}))

export function setSwitchingTo(sessionId: string, accountName: string | null): void {
  useCodexSwitchingStore.setState((state) => {
    const { [sessionId]: _done, ...rest } = state
    return accountName ? { ...rest, [sessionId]: accountName } : rest
  }, true)
}

const dismissed = new Set<string>()

export interface CodexLimit {
  ctx: ProjectCodexAccount
  limit: ClaudeRateLimit
  name: string
  reset: string | null
  dismiss: () => void
  switchTo: (target: CodexAccountChoice) => Promise<void>
  switchingTo: string | null
}

/**
 * Live limit state of one Codex chat, shared by the composer warning and the
 * at-limit card. `null` when there is no limit to show or the user dismissed it.
 */
export function useCodexLimit(sessionId: string): CodexLimit | null {
  const ctx = useChatCodexAccount(sessionId)
  const live = useAcpStore((state) => state.sessionUsage?.[sessionId]?.rateLimit ?? null)
  const openTurnId = useAcpStore((state) => state.sessions[sessionId]?.openTurnId ?? null)
  const cancelResume = useCodexResumeStore((state) => state.cancel)
  const scheduledTurn = useCodexResumeStore((state) =>
    sessionId in state.turns ? state.turns[sessionId] : undefined
  )
  const switchingTo = useCodexSwitchingStore((state) => state[sessionId] ?? null)
  useEffect(() => {
    if (scheduledTurn === undefined) return
    if (turnReplaced(scheduledTurn, openTurnId)) cancelResume(sessionId)
  }, [scheduledTurn, openTurnId, sessionId, cancelResume])
  const [, rerender] = useState(0)
  const limit = ctx ? codexDisplayLimit(live, ctx.current.usage) : null
  if (!ctx || !limit) return null

  const key = `${sessionId}:${limit.status}:${limit.resetsAt ?? ''}`
  if (dismissed.has(key)) return null

  const projectId = ctx.projectId
  const currentAccountId = ctx.current.account.id
  const reloadAccounts = ctx.accounts.reload
  const atLimit = limit.status === 'rejected'
  async function switchTo(target: CodexAccountChoice): Promise<void> {
    setSwitchingTo(sessionId, target.account.name)
    cancelResume(sessionId)
    try {
      const continued = await switchProjectCodexAccount(projectId, target.account.id, {
        continueSessionIds: atLimit ? [sessionId] : undefined,
        expectedAccountId: currentAccountId
      })
      await reloadAccounts()
      if (continued === null) {
        toast.info('That account was changed on another client')
        return
      }
      toast.success(`Switched to ${target.account.name}`)
    } catch (err) {
      toastAccountChoiceError(err, 'Could not switch')
      void reloadAccounts()
    } finally {
      setSwitchingTo(sessionId, null)
    }
  }

  return {
    ctx,
    limit,
    name: ctx.current.account.name,
    reset: formatUsageReset(limit.resetsAt),
    dismiss: () => {
      dismissed.add(key)
      rerender((count) => count + 1)
    },
    switchTo,
    switchingTo
  }
}
