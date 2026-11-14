import type { CodexAccountView } from '@shared/types/codex-accounts.types'
import { CODEX_AGENT_CONFIG_ID } from '@shared/types/codex-accounts.types'
import { useEffect, useRef } from 'react'
import {
  CODEX_CLI_SIGNED_OUT_MESSAGE,
  type CodexCliAuthState,
  codexAuthSyncDecision,
  isCodexAcpConfig
} from '@/lib/agents/codex-cli-auth'
import { codexAccountsApi } from '@/lib/codex-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { isDetachedReuseKey, parseReuseKey } from '@/stores/acp-reuse-keys'
import { plainLastError, useAcpStore } from '@/stores/acp-store'
import { isAnyAgentAuthInFlight } from '@/stores/acp-store/slices/agent'
import { useProjectStore } from '@/stores/project-store'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

const POLL_MS = 4000

function authState(account: CodexAccountView | undefined): CodexCliAuthState | null {
  if (!account || account.signedIn === null) return 'unavailable'
  return account.signedIn ? 'signed-in' : 'signed-out'
}

/**
 * Keep open Codex chats on the login the account snapshot reports for each
 * home. `codex login` and `codex logout` outside Troupe change that login.
 * This poll restarts the agent when the snapshot for that home changes.
 */
export function CodexCliAuthSync(): null {
  const baselines = useRef(new Map<string, CodexCliAuthState | null>())
  const running = useRef(false)

  useEffect(() => {
    let stopped = false

    const tick = async (): Promise<void> => {
      if (running.current) return
      running.current = true
      try {
        const before = useAcpStore.getState()
        const hasCodex = before.agentConfigs.some(isCodexAcpConfig)
        if (!hasCodex) return
        let snapshot: Awaited<ReturnType<typeof codexAccountsApi.list>>
        try {
          snapshot = await codexAccountsApi.list()
        } catch (error) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.codexCliAuth',
            message: `Codex account list failed: ${error instanceof Error ? error.message : String(error)}`
          })
          return
        }
        if (stopped) return

        const live = useAcpStore.getState()
        const projects = useProjectStore.getState().projects
        const byAccount = new Map<
          string,
          {
            agentIds: string[]
            sessionIds: string[]
            restarts: { cwd: string; projectId: string; configId: string }[]
          }
        >()
        for (const [key, agentId] of Object.entries(live.configToLiveAgent)) {
          if (isDetachedReuseKey(key)) continue
          const parsed = parseReuseKey(key)
          const config = live.agentConfigs.find((item) => item.id === parsed.configId)
          if (!config || !isCodexAcpConfig(config)) continue
          const cwd = parsed.cwd.trim()
          if (!cwd) continue
          const session = Object.values(live.sessions).find((item) => item.agentId === agentId)
          const projectId =
            parsed.projectId || session?.projectId || projects.find((item) => item.path === cwd)?.id
          if (!projectId) continue
          const accountId = snapshot.projectAccounts[projectId] ?? snapshot.defaultAccountId
          const group = byAccount.get(accountId) ?? { agentIds: [], sessionIds: [], restarts: [] }
          group.agentIds.push(agentId)
          group.restarts.push({ cwd, projectId, configId: parsed.configId })
          byAccount.set(accountId, group)
        }
        for (const session of Object.values(live.sessions)) {
          const group = [...byAccount.values()].find((item) =>
            item.agentIds.includes(session.agentId)
          )
          if (group) group.sessionIds.push(session.id)
        }

        for (const [accountId, group] of byAccount) {
          const account = snapshot.accounts.find((item) => item.id === accountId)
          const next = authState(account)
          if (!next) continue
          const hasAuthError = Object.entries(live.prepareChatErrors).some(([key, error]) => {
            const parsed = parseReuseKey(key)
            return isCodexAcpConfig({ id: parsed.configId }) && error.category === 'auth'
          })
          const authBusy =
            isAnyAgentAuthInFlight() ||
            group.agentIds.some((agentId) => Boolean(live.pendingSignIn[agentId]))
          const decision = codexAuthSyncDecision({
            previous: baselines.current.get(accountId) ?? null,
            next,
            authBusy,
            hasLiveAgent: group.agentIds.length > 0,
            hasAuthError
          })
          if (decision.action === 'none') {
            baselines.current.set(accountId, decision.previous)
            continue
          }
          try {
            void logFrontendError({
              level: 'info',
              source: 'acp.codexCliAuth',
              message: `Codex account ${accountId} login changed to ${next}; restarting the Codex agent`
            })
            for (const agentId of group.agentIds) {
              await useAcpStore.getState().killAgent(agentId)
            }
            if (decision.action === 'refresh-after-cli-logout') {
              useAcpStore.setState((current) => {
                let changed = false
                const sessions = { ...current.sessions }
                for (const sessionId of group.sessionIds) {
                  const session = sessions[sessionId]
                  if (!session) continue
                  sessions[sessionId] = {
                    ...session,
                    ...plainLastError(CODEX_CLI_SIGNED_OUT_MESSAGE)
                  }
                  changed = true
                }
                return changed ? { sessions } : {}
              })
              const workspace = useWorkspaceStore.getState()
              for (const sessionId of group.sessionIds) {
                const tabId = agentChatTabId(sessionId)
                const pane = findPaneContainingTab(workspace.root, tabId)
                if (!pane || pane.activeTabId !== tabId) continue
                workspace.showAgentLauncher(pane.id)
                break
              }
            }
            if (stopped) return
            const seen = new Set<string>()
            for (const item of group.restarts) {
              const restartKey = `${item.projectId}\0${item.cwd}`
              if (seen.has(restartKey)) continue
              seen.add(restartKey)
              useAcpStore
                .getState()
                .prepareChat(
                  item.configId || CODEX_AGENT_CONFIG_ID,
                  item.cwd,
                  undefined,
                  item.projectId
                )
            }
            baselines.current.set(accountId, decision.previous)
          } catch (error) {
            void logFrontendError({
              level: 'warn',
              source: 'acp.codexCliAuth',
              message: `Codex account restart failed: ${error instanceof Error ? error.message : String(error)}`
            })
          }
        }
      } finally {
        running.current = false
      }
    }

    void tick()
    const timer = setInterval(() => {
      void tick()
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])

  return null
}
