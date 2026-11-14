/**
 * Automatic Codex Account switching. When a managed Codex chat reaches its
 * Account's limit, the chat's Project moves to the signed-in Account with the
 * most room and the chat continues there. The last prompt is sent again and
 * the held turn is cancelled. A compare-and-set on the current Account keeps
 * two clients from switching the same Project twice.
 */

import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import type { CodexAccountUsage, CodexUsageWindow } from '@shared/types/codex-accounts.types'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { codexAccountsApi } from '@/lib/codex-accounts-api'
import { codexResetSeconds, primaryCodexWindow } from '@/lib/codex-usage-format'
import { logFrontendError } from '@/lib/log-api'
import { type AcpState, useAcpStore } from '@/stores/acp-store'
import { withRateLimit } from '@/stores/acp-store/rate-limit'
import {
  applyProjectCodexAccount,
  isChatOpenHere,
  isCodexSession,
  restartCodexSession,
  runsProjectAccount,
  switchProjectCodexAccount
} from '@/stores/codex-account-switch'
import {
  formatClock,
  isAtLimit,
  setSwitchingTo,
  useCodexResumeStore,
  useCodexSwitchingStore,
  windowName
} from './use-codex-limit'
import {
  type CodexAccountChoice,
  projectCodexAccountId,
  rankCodexAlternatives
} from './use-project-codex-account'

export type AutoSwitchDecision =
  | { kind: 'switch'; to: CodexAccountChoice }
  | { kind: 'resume'; at: number }
  | { kind: 'none'; reason: 'off' | 'no-room' }

export interface AutoSwitchInput {
  limit: ClaudeRateLimit
  autoSwitch: boolean
  candidates: readonly CodexAccountChoice[]
  limited: ReadonlyMap<string, number>
  now: number
}

export function decideAutoSwitch({
  limit,
  autoSwitch,
  candidates,
  limited,
  now
}: AutoSwitchInput): AutoSwitchDecision {
  if (!autoSwitch) return { kind: 'none', reason: 'off' }
  const to = candidates.find((candidate) => (limited.get(candidate.account.id) ?? 0) <= now)
  if (to) return { kind: 'switch', to }
  if (limit.resetsAt !== null) return { kind: 'resume', at: limit.resetsAt * 1000 }
  return { kind: 'none', reason: 'no-room' }
}

const log = (message: string, level: 'info' | 'warn' = 'info'): void =>
  void logFrontendError({ level, source: 'codexAutoSwitch', message })

const READ_RETRY_MS = 30_000
const CODEX_SHORTEST_WINDOW_MS = 5 * 60 * 60 * 1000
const PROBE_STAMP_MS = 20_000

const limitEvent = (limit: ClaudeRateLimit): string => `${limit.kind ?? ''}:${limit.resetsAt ?? ''}`

interface LimitedChat {
  sessionId: string
  projectId: string
  limit: ClaudeRateLimit
}

function limitedChats(state: AcpState): LimitedChat[] {
  const chats: LimitedChat[] = []
  for (const [sessionId, usage] of Object.entries(state.sessionUsage)) {
    const limit = usage?.rateLimit
    const projectId = state.sessions[sessionId]?.projectId
    if (!limit || !isAtLimit(limit) || !projectId || !isCodexSession(state, sessionId)) continue
    chats.push({ sessionId, projectId, limit })
  }
  return chats
}

/** A window whose reset time is still ahead. A missing time stays usable. */
function windowStillOpen(window: CodexUsageWindow, now = Date.now()): boolean {
  const resetAt = codexResetSeconds(window)
  return resetAt === null || resetAt * 1000 > now
}

/** Fill a rejected turn from the last good probe when the error has no reset time. */
function withProbe(limit: ClaudeRateLimit, read: CodexAccountUsage | undefined): ClaudeRateLimit {
  const window = primaryCodexWindow(read)
  if (!window || !windowStillOpen(window)) return limit
  return {
    ...limit,
    kind: limit.kind ?? (window.kind === 'weekly' ? 'seven_day' : 'five_hour'),
    percent: limit.percent ?? window.percent,
    resetsAt: limit.resetsAt ?? codexResetSeconds(window)
  }
}

/**
 * A probe at 100% is the same limit as a mid-turn `rate_limited` /
 * `quota_exhausted` error. The reset time is the probe's.
 */
async function stampProbeLimits(): Promise<void> {
  const [snapshot, usage] = await Promise.all([
    codexAccountsApi.list(),
    codexAccountsApi.usage(false)
  ])
  const reads = Object.fromEntries(usage.map((read) => [read.accountId, read]))
  const state = useAcpStore.getState()
  let next: AcpState['sessionUsage'] | null = null
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (!session.projectId || !isCodexSession(state, sessionId)) continue
    if (state.sessionUsage[sessionId]?.rateLimit?.status === 'rejected') continue
    // A finished chat stays on screen. Only a turn that is still held is resent.
    const held = session.activeTurn === true || session.openTurnId != null
    if (!held || !runsProjectAccount(state, sessionId)) continue
    const accountId = projectCodexAccountId(snapshot, session.projectId)
    const window = primaryCodexWindow(reads[accountId])
    if (!window || window.percent < 100 || !windowStillOpen(window)) continue
    const limit: ClaudeRateLimit = {
      status: 'rejected',
      resetsAt: codexResetSeconds(window),
      kind: window.kind === 'weekly' ? 'seven_day' : 'five_hour',
      percent: 100,
      overageInUse: false
    }
    next = {
      ...(next ?? state.sessionUsage),
      [sessionId]: withRateLimit(state.sessionUsage[sessionId], limit)
    }
  }
  if (next) useAcpStore.setState({ sessionUsage: next })
}

/**
 * Watch every Codex chat's limit and act on each new limit once. Only a
 * client that has the chat open acts. Returns the stop function.
 */
export function startCodexAutoSwitch(): () => void {
  const handled = new Map<string, string>()
  const attempts = new Set<string>()
  const limitedAccounts = new Map<string, number>()
  const busyProjects = new Set<string>()
  let lastUsage: AcpState['sessionUsage'] | null = null
  let stopped = false

  async function act(projectId: string, chats: readonly LimitedChat[]): Promise<void> {
    const state = useAcpStore.getState()
    const outdated = chats.filter(({ sessionId }) => !runsProjectAccount(state, sessionId))
    await Promise.all(
      outdated.map(({ sessionId }) => {
        log(
          `Chat ${sessionId} reached a limit on an agent started before project ${projectId} changed its account; restarting it on the project's account`
        )
        return restartCodexSession(sessionId, { resend: true, cancelTurn: true })
      })
    )
    const current = chats.filter((chat) => !outdated.includes(chat))
    if (current.length === 0) return

    const snapshot = await codexAccountsApi.list()
    const currentId = projectCodexAccountId(snapshot, projectId)
    const usage = snapshot.autoSwitch ? await codexAccountsApi.usage(true) : []
    const reads = Object.fromEntries(usage.map((read) => [read.accountId, read]))
    const fresh = current
      .map((chat) => ({ ...chat, limit: withProbe(chat.limit, reads[currentId]) }))
      .filter(({ sessionId, limit }) => {
        const attempt = `${sessionId}:${limit.resetsAt ?? ''}:${currentId}`
        if (attempts.has(attempt)) return false
        attempts.add(attempt)
        return true
      })
    const [lead] = fresh
    if (!lead) {
      log(`Skipped project ${projectId}: these limits were already handled`)
      return
    }
    const sessionIds = fresh.map((chat) => chat.sessionId)
    const idList = sessionIds.join(', ')
    limitedAccounts.set(
      currentId,
      lead.limit.resetsAt === null
        ? Date.now() + CODEX_SHORTEST_WINDOW_MS
        : lead.limit.resetsAt * 1000
    )
    if (sessionIds.some((id) => useCodexSwitchingStore.getState()[id])) {
      log(`Skipped chats ${idList}: a switch is already running`)
      return
    }
    const decision = decideAutoSwitch({
      limit: lead.limit,
      autoSwitch: snapshot.autoSwitch,
      candidates: rankCodexAlternatives(snapshot, reads, currentId),
      limited: limitedAccounts,
      now: Date.now()
    })
    const name =
      snapshot.accounts.find((account) => account.id === currentId)?.name ?? 'The account'
    const reached = `${name} reached its ${windowName(lead.limit)} limit.`

    switch (decision.kind) {
      case 'none':
        log(
          decision.reason === 'off'
            ? `Skipped chats ${idList}: automatic switching is off`
            : `Skipped chats ${idList}: no other account has room and the reset time is unknown`
        )
        return
      case 'resume': {
        log(`No other account has room; chats ${idList} continue when the limit resets`)
        for (const { sessionId, limit } of fresh) {
          const at = limit.resetsAt === null ? decision.at : limit.resetsAt * 1000
          useCodexResumeStore.getState().schedule(sessionId, at)
        }
        toast.info(`${reached} No other account has room.`, {
          description: `The chat continues at ${formatClock(decision.at)}.`
        })
        return
      }
      case 'switch': {
        const { to } = decision
        log(`Chats ${idList} reached the limit; switching project ${projectId} and continuing`)
        for (const id of sessionIds) {
          setSwitchingTo(id, to.account.name)
          useCodexResumeStore.getState().cancel(id)
        }
        try {
          const continued = await switchProjectCodexAccount(projectId, to.account.id, {
            continueSessionIds: sessionIds,
            expectedAccountId: currentId
          })
          if (!continued) {
            log(
              `Another client switched project ${projectId} first; restarting chats ${idList} on its account`
            )
            await applyProjectCodexAccount(projectId, { continueSessionIds: sessionIds })
            return
          }
          const stalled = sessionIds.filter((id) => !continued.includes(id))
          if (stalled.length > 0) {
            log(
              `Project ${projectId} switched to ${to.account.name}, but chats ${stalled.join(', ')} could not continue`,
              'warn'
            )
            toast.warning(
              `${reached} Switched to ${to.account.name}, but the chat did not continue.`,
              { description: 'Send the message again to continue.' }
            )
            if (continued.length === 0) return
          }
          log(`Project ${projectId} switched; chats ${continued.join(', ')} continued`)
          toast.success(`${reached} Continued on ${to.account.name}.`)
        } catch (error) {
          log(
            `Switching project ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`,
            'warn'
          )
          toastAccountChoiceError(
            error,
            'Could not confirm the account switch or continue the chat'
          )
          for (const id of sessionIds) {
            for (const key of [...attempts]) {
              if (key.startsWith(`${id}:`)) attempts.delete(key)
            }
          }
          throw error
        } finally {
          for (const id of sessionIds) setSwitchingTo(id, null)
        }
      }
    }
  }

  function check(state: AcpState): void {
    if (stopped || state.sessionUsage === lastUsage) return
    lastUsage = state.sessionUsage
    for (const sessionId of handled.keys()) {
      const limit = state.sessionUsage[sessionId]?.rateLimit
      if (!limit || !isAtLimit(limit)) handled.delete(sessionId)
    }
    const byProject = new Map<string, LimitedChat[]>()
    for (const chat of limitedChats(state)) {
      if (handled.get(chat.sessionId) === limitEvent(chat.limit)) continue
      if (busyProjects.has(chat.projectId) || !isChatOpenHere(chat.sessionId)) continue
      handled.set(chat.sessionId, limitEvent(chat.limit))
      byProject.set(chat.projectId, [...(byProject.get(chat.projectId) ?? []), chat])
    }
    for (const [projectId, chats] of byProject) {
      busyProjects.add(projectId)
      void act(projectId, chats)
        .catch((error) => {
          log(
            `Automatic switching of project ${projectId} failed: ${error instanceof Error ? error.message : String(error)}; trying again in ${READ_RETRY_MS / 1000}s`,
            'warn'
          )
          setTimeout(() => {
            for (const { sessionId } of chats) handled.delete(sessionId)
            lastUsage = null
            check(useAcpStore.getState())
          }, READ_RETRY_MS)
        })
        .finally(() => {
          busyProjects.delete(projectId)
          lastUsage = null
          check(useAcpStore.getState())
        })
    }
  }

  check(useAcpStore.getState())
  void stampProbeLimits().catch((error) => {
    log(
      `Could not read Codex usage: ${error instanceof Error ? error.message : String(error)}`,
      'warn'
    )
  })
  const timer = setInterval(() => {
    void stampProbeLimits().catch(() => undefined)
  }, PROBE_STAMP_MS)
  const unsubscribe = useAcpStore.subscribe(check)
  return () => {
    stopped = true
    clearInterval(timer)
    unsubscribe()
  }
}

/** Mount once per renderer root. */
export function useCodexAutoSwitch(): void {
  useEffect(() => startCodexAutoSwitch(), [])
}
