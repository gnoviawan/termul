import { useEffect, useRef } from 'react'
import {
  CODEX_CLI_SIGNED_OUT_MESSAGE,
  type CodexCliAuthState,
  codexAuthSyncDecision,
  codexHomeFromConfig,
  isCodexAcpConfig
} from '@/lib/agents/codex-cli-auth'
import { invokeIpcWrapped } from '@/lib/ipc/tauri'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useAcpStore } from '@/stores/acp-store'
import { isAnyAgentAuthInFlight } from '@/stores/acp-store/slices/agent'
import { useProjectStore } from '@/stores/project-store'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

const POLL_MS = 4000

/**
 * Keep the Termul Codex agent on the same login as the Codex CLI.
 * `codex login` and `codex logout` update that store. This poll restarts the
 * agent when the CLI state changes, so the next chat uses the new login.
 */
export function CodexCliAuthSync(): null {
  const baselines = useRef(new Map<string, CodexCliAuthState | null>())
  const running = useRef(false)

  useEffect(() => {
    if (!isTauriContext()) return
    let stopped = false

    const tick = async (): Promise<void> => {
      if (running.current) return
      running.current = true
      try {
        const before = useAcpStore.getState()
        const config =
          before.agentConfigs.find(
            (item) => item.id === before.selectedAgentConfigId && isCodexAcpConfig(item)
          ) ?? before.agentConfigs.find((item) => isCodexAcpConfig(item))
        if (!config) return
        const baselineKey = `${config.id}\0${codexHomeFromConfig(config) ?? ''}`

        const status = await invokeIpcWrapped<{ state: CodexCliAuthState }>(
          'codex_cli_auth_status',
          { codexHome: codexHomeFromConfig(config) }
        )
        if (stopped || !status.success || !status.data) return
        const next = status.data.state
        if (next !== 'signed-in' && next !== 'signed-out' && next !== 'unavailable') return

        const live = useAcpStore.getState()
        const stillSelected = live.agentConfigs.some(
          (item) => item.id === config.id && isCodexAcpConfig(item)
        )
        if (!stillSelected) return
        const prefix = `${config.id}\0`
        const projects = useProjectStore.getState().projects
        const restarts = Object.entries(live.configToLiveAgent).flatMap(([key, agentId]) => {
          if (!key.startsWith(prefix)) return []
          const cwd = key.slice(prefix.length).trim()
          if (!cwd) return []
          const session = Object.values(live.sessions).find((item) => item.agentId === agentId)
          const projectId = session?.projectId ?? projects.find((item) => item.path === cwd)?.id
          if (!projectId) return []
          return [{ agentId, cwd, projectId }]
        })
        const liveAgentIds = restarts.map((item) => item.agentId)
        const liveSessionIds = Object.values(live.sessions)
          .filter((session) => liveAgentIds.includes(session.agentId))
          .map((session) => session.id)
        const hasAuthError = Object.entries(live.prepareChatErrors).some(
          ([key, error]) => key.startsWith(prefix) && error.category === 'auth'
        )
        const authBusy =
          isAnyAgentAuthInFlight() ||
          liveAgentIds.some((agentId) => Boolean(live.pendingBrowserOpen[agentId]))
        const decision = codexAuthSyncDecision({
          previous: baselines.current.get(baselineKey) ?? null,
          next,
          authBusy,
          hasLiveAgent: liveAgentIds.length > 0,
          hasAuthError
        })
        if (decision.action === 'none') {
          baselines.current.set(baselineKey, decision.previous)
          return
        }

        try {
          void logFrontendError({
            level: 'info',
            source: 'acp.codexCliAuth',
            message: `Codex CLI auth changed to ${next}; restarting the Codex agent`
          })
          for (const item of restarts) {
            await useAcpStore.getState().killAgent(item.agentId)
          }
          if (decision.action === 'refresh-after-cli-logout') {
            useAcpStore.setState((current) => {
              let changed = false
              const sessions = { ...current.sessions }
              for (const sessionId of liveSessionIds) {
                const session = sessions[sessionId]
                if (!session) continue
                sessions[sessionId] = { ...session, lastError: CODEX_CLI_SIGNED_OUT_MESSAGE }
                changed = true
              }
              return changed ? { sessions } : {}
            })
            const workspace = useWorkspaceStore.getState()
            for (const sessionId of liveSessionIds) {
              const tabId = agentChatTabId(sessionId)
              const pane = findPaneContainingTab(workspace.root, tabId)
              if (!pane || pane.activeTabId !== tabId) continue
              workspace.showAgentLauncher(pane.id)
              break
            }
          }
          if (stopped) return
          const seen = new Set<string>()
          for (const item of restarts) {
            const restartKey = `${item.projectId}\0${item.cwd}`
            if (seen.has(restartKey)) continue
            seen.add(restartKey)
            useAcpStore.getState().prepareChat(config.id, item.cwd, undefined, item.projectId)
          }
          if (seen.size === 0) {
            const projectState = useProjectStore.getState()
            const project = projectState.projects.find(
              (item) => item.id === projectState.activeProjectId
            )
            const cwd = project?.path?.trim()
            if (cwd) {
              useAcpStore
                .getState()
                .prepareChat(config.id, cwd, undefined, projectState.activeProjectId)
            }
          }
          baselines.current.set(baselineKey, decision.previous)
        } catch (error) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.codexCliAuth',
            message: `Codex CLI auth restart failed: ${error instanceof Error ? error.message : String(error)}`
          })
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
