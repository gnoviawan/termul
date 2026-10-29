/**
 * Automatic Claude Account switching: when a managed Claude chat reaches its
 * Account's limit, the chat's Project moves to the signed-in Account with the
 * most room and the chat continues there, or continues when the window resets
 * when no Account has room. It runs for the whole app, so a chat on another
 * tab or Project continues too. The in-chat card shows the same states.
 */

import type { ClaudeRateLimit } from '@shared/types/claude-accounts.types'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { toastAccountChoiceError } from '@/components/settings/provider/account-choice-error'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { type AcpState, useAcpStore } from '@/stores/acp-store'
import {
  isChatOpenHere,
  isClaudeSession,
  switchProjectClaudeAccount
} from '@/stores/claude-account-switch'
import {
  formatClock,
  isAtLimit,
  setSwitchingTo,
  useClaudeResumeStore,
  useClaudeSwitchingStore,
  windowName
} from './use-claude-limit'
import {
  type AccountChoice,
  projectAccountId,
  rankAlternatives
} from './use-project-claude-account'

export type AutoSwitchDecision =
  | { kind: 'switch'; to: AccountChoice }
  /** No Account has room: continue when the window resets, epoch ms. */
  | { kind: 'resume'; at: number }
  | { kind: 'none'; reason: 'off' | 'no-room' }

export interface AutoSwitchInput {
  limit: ClaudeRateLimit
  autoSwitch: boolean
  /** Other signed-in Accounts with room, least used first (`rankAlternatives`). */
  candidates: readonly AccountChoice[]
  /** Accounts that reached a limit earlier, with their reset in epoch ms (`null`: unknown). */
  limited: ReadonlyMap<string, number | null>
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
  // The usage read is cached on the host, so an Account that just reached its
  // limit can still look like it has room.
  const stillLimited = (id: string): boolean => {
    const reset = limited.get(id)
    return reset !== undefined && (reset === null || reset > now)
  }
  const to = candidates.find((c) => !stillLimited(c.account.id))
  if (to) return { kind: 'switch', to }
  if (limit.resetsAt !== null) return { kind: 'resume', at: limit.resetsAt * 1000 }
  return { kind: 'none', reason: 'no-room' }
}

const log = (message: string, level: 'info' | 'warn' = 'info'): void =>
  void logFrontendError({ level, source: 'claudeAutoSwitch', message })

/** Wait before a limit whose Account or usage read failed is tried again. */
const READ_RETRY_MS = 30_000

const limitEvent = (limit: ClaudeRateLimit): string => `${limit.kind ?? ''}:${limit.resetsAt ?? ''}`

interface LimitedChat {
  sessionId: string
  projectId: string
  limit: ClaudeRateLimit
}

/** Managed Claude chats at their Account's limit. */
function limitedChats(state: AcpState): LimitedChat[] {
  const chats: LimitedChat[] = []
  for (const [sessionId, usage] of Object.entries(state.sessionUsage)) {
    const limit = usage?.rateLimit
    const projectId = state.sessions[sessionId]?.projectId
    if (!limit || !isAtLimit(limit) || !projectId || !isClaudeSession(state, sessionId)) continue
    chats.push({ sessionId, projectId, limit })
  }
  return chats
}

/**
 * Watch every chat's live limit state and act on each new limit once. Only a
 * client that has the chat open acts: a client without it would stop the
 * agent instead of sending the prompt again. Returns the stop function.
 */
export function startClaudeAutoSwitch(): () => void {
  /** The limit state each chat was last acted on; a repeat of it does nothing. */
  const handled = new Map<string, string>()
  /** `session:resetsAt:account` of every limit acted on. */
  const attempts = new Set<string>()
  /** Accounts that reached a limit, so no chat moves back to one before its reset. */
  const limitedAccounts = new Map<string, number | null>()
  const busyProjects = new Set<string>()
  let lastUsage: AcpState['sessionUsage'] | null = null
  let stopped = false

  /** Act on the chats of one Project that reached a limit; all share its Account. */
  async function act(projectId: string, chats: readonly LimitedChat[]): Promise<void> {
    const snapshot = await claudeAccountsApi.list()
    const currentId = projectAccountId(snapshot, projectId)
    const fresh = chats.filter(({ sessionId, limit }) => {
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
    const sessionIds = fresh.map((c) => c.sessionId)
    const idList = sessionIds.join(', ')
    limitedAccounts.set(currentId, lead.limit.resetsAt === null ? null : lead.limit.resetsAt * 1000)
    if (sessionIds.some((id) => useClaudeSwitchingStore.getState()[id])) {
      log(`Skipped chats ${idList}: a switch is already running`)
      return
    }
    const usage = snapshot.autoSwitch ? await claudeAccountsApi.usage(true) : []
    const decision = decideAutoSwitch({
      limit: lead.limit,
      autoSwitch: snapshot.autoSwitch,
      candidates: rankAlternatives(
        snapshot,
        Object.fromEntries(usage.map((read) => [read.accountId, read])),
        currentId
      ),
      limited: limitedAccounts,
      now: Date.now()
    })
    const name = snapshot.accounts.find((a) => a.id === currentId)?.name ?? 'The account'
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
          useClaudeResumeStore.getState().schedule(sessionId, at)
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
          useClaudeResumeStore.getState().cancel(id)
        }
        try {
          const continued = await switchProjectClaudeAccount(projectId, to.account.id, {
            continueSessionIds: sessionIds,
            expectedAccountId: currentId
          })
          if (!continued) {
            log(
              `Another client switched project ${projectId} first; chats ${idList} continue there`
            )
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
              {
                description: 'Send the message again to continue.'
              }
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
          // The Account or usage read failed before anything changed: let these
          // limits be tried again after a pause.
          log(
            `Automatic switching of project ${projectId} failed: ${error instanceof Error ? error.message : String(error)}; trying again in ${READ_RETRY_MS / 1000}s`,
            'warn'
          )
          setTimeout(() => {
            for (const { sessionId, limit } of chats) {
              handled.delete(sessionId)
              const prefix = `${sessionId}:${limit.resetsAt ?? ''}:`
              for (const attempt of attempts)
                if (attempt.startsWith(prefix)) attempts.delete(attempt)
            }
            lastUsage = null
            check(useAcpStore.getState())
          }, READ_RETRY_MS)
        })
        .finally(() => {
          busyProjects.delete(projectId)
          // A chat that reached its limit during this run is checked now.
          lastUsage = null
          check(useAcpStore.getState())
        })
    }
  }

  check(useAcpStore.getState())
  const unsubscribe = useAcpStore.subscribe(check)
  return () => {
    stopped = true
    unsubscribe()
  }
}

/** Mount once per renderer root. */
export function useClaudeAutoSwitch(): void {
  useEffect(() => startClaudeAutoSwitch(), [])
}
