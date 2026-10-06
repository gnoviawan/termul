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
  const previous = useRef<CodexCliAuthState | null>(null)
  const running = useRef(false)

  useEffect(() => {
    if (!isTauriContext()) return
    let stopped = false

    const tick = async (): Promise<void> => {
      if (running.current) return
      running.current = true
      try {
        const state = useAcpStore.getState()
        const config =
          state.agentConfigs.find(
            (item) => item.id === state.selectedAgentConfigId && isCodexAcpConfig(item)
          ) ?? state.agentConfigs.find((item) => isCodexAcpConfig(item))
        if (!config) return

        const status = await invokeIpcWrapped<{ state: CodexCliAuthState }>(
          'codex_cli_auth_status',
          { codexHome: codexHomeFromConfig(config) }
        )
        if (stopped || !status.success || !status.data) return
        const next = status.data.state
        if (next !== 'signed-in' && next !== 'signed-out' && next !== 'unavailable') return

        const liveAgentIds = Object.entries(state.configToLiveAgent)
          .filter(([key]) => key.startsWith(`${config.id}\0`))
          .map(([, agentId]) => agentId)
        const liveSessionIds = Object.values(state.sessions)
          .filter((session) => liveAgentIds.includes(session.agentId))
          .map((session) => session.id)
        const hasAuthError = Object.entries(state.prepareChatErrors).some(
          ([key, error]) => key.startsWith(`${config.id}\0`) && error.category === 'auth'
        )
        const authBusy =
          isAnyAgentAuthInFlight() ||
          liveAgentIds.some((agentId) => Boolean(state.pendingBrowserOpen[agentId]))
        const decision = codexAuthSyncDecision({
          previous: previous.current,
          next,
          authBusy,
          hasLiveAgent: liveAgentIds.length > 0,
          hasAuthError
        })
        previous.current = decision.previous
        if (decision.action === 'none') return

        void logFrontendError({
          level: 'info',
          source: 'acp.codexCliAuth',
          message: `Codex CLI auth changed to ${next}; restarting the Codex agent`
        })
        for (const agentId of liveAgentIds) {
          await useAcpStore.getState().killAgent(agentId)
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
        const projectState = useProjectStore.getState()
        const project = projectState.projects.find(
          (item) => item.id === projectState.activeProjectId
        )
        const cwd = project?.path?.trim()
        if (!cwd) return
        useAcpStore.getState().prepareChat(config.id, cwd, undefined, projectState.activeProjectId)
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
