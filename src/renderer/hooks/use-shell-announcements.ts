import { useEffect } from 'react'
import { logFrontendError } from '@/lib/log-api'
import {
  type AcpAnnouncementMemory,
  type AnnouncementContext,
  type ConnectionAnnouncementMemory,
  type ConnectionAnnouncementState,
  deriveAcpAnnouncements,
  deriveConnectionAnnouncements,
  resolveChatLabel
} from '@/lib/shell-announcements'
import { type AcpState, isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useProjectStore } from '@/stores/project-store'
import { useShellAnnouncerStore } from '@/stores/shell-announcer-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'

const LOG_SOURCE = 'shell-announcer'

/** Log an evaluation failure at `warn`. Never includes chat titles or other user content. */
function logEvaluationFailure(scope: 'acp' | 'connection', error: unknown): void {
  try {
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message: `Shell announcement evaluation failed (${scope}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      stack: error instanceof Error ? error.stack : undefined
    })
  } catch {
    // Logging is best effort: a failing logger must not reach the store's set().
  }
}

/**
 * Read everything outside the ACP store that decides who an announcement is
 * for. Mirrors the candidate set in `use-agent-chat-attention` (open
 * `agent-chat` tabs plus retained chats, minus ephemeral sessions) and the
 * active-tab rule in `MobileChatShell`.
 */
function readContext(state: AcpState): AnnouncementContext {
  const workspace = useWorkspaceStore.getState()
  const leaves = getAllLeafPanes(workspace.root)
  const candidateChatIds = new Set<string>()
  const addCandidate = (sessionId: string): void => {
    if (!isEphemeralAcpSession(sessionId)) candidateChatIds.add(sessionId)
  }
  for (const leaf of leaves) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'agent-chat') addCandidate(tab.sessionId)
    }
  }
  for (const ids of Object.values(useAgentChatLifetimeStore.getState().retainedByProject)) {
    for (const sessionId of ids) addCandidate(sessionId)
  }

  const activePane = leaves.find((pane) => pane.id === workspace.activePaneId) ?? leaves[0]
  const activeTab = activePane?.tabs.find((tab) => tab.id === activePane.activeTabId)
  const projects = useProjectStore.getState()

  return {
    activeChatId: activeTab?.type === 'agent-chat' ? activeTab.sessionId : null,
    activeProjectId: projects.activeProjectId,
    candidateChatIds,
    chatLabel: (sessionId) =>
      resolveChatLabel(
        state.sessions[sessionId]?.title,
        state.sessionIndex.find((entry) => entry.id === sessionId)?.title
      ),
    projectName: (projectId) => projects.projects.find((p) => p.id === projectId)?.name || projectId
  }
}

/** True when none of the slices the announcer reads changed. */
function acpSlicesUnchanged(next: AcpState, prev: AcpState): boolean {
  return (
    next.sessions === prev.sessions &&
    next.agentStatus === prev.agentStatus &&
    next.pendingPermissions === prev.pendingPermissions &&
    next.pendingQuestions === prev.pendingQuestions &&
    next.pendingElicitations === prev.pendingElicitations &&
    next.permissionDenialNotices === prev.permissionDenialNotices &&
    next.switchingProjectId === prev.switchingProjectId &&
    next.failedProjectSwitchId === prev.failedProjectSwitchId
  )
}

/**
 * Feed the mobile shell live region.
 *
 * Registers the region with the announcer store, then diffs consecutive
 * `useAcpStore` and `useConnectionStatusStore` states in zustand `subscribe`
 * listeners (not React renders, so it costs nothing per streamed chunk and
 * sees values that are set and cleared within one tick). Both stores are
 * read once on mount as a silent baseline.
 *
 * Renderer-only and derived entirely from stores, so desktop shared-live
 * remote clients and standalone `termul-server` web clients behave the same.
 * Mount it once, from `MobileChatShell` only.
 */
export function useShellAnnouncements(): void {
  useEffect(() => {
    const unregisterRegion = useShellAnnouncerStore.getState().registerRegion()
    let acpMemory: AcpAnnouncementMemory | null = null
    let connectionMemory: ConnectionAnnouncementMemory | null = null

    const evaluateAcp = (state: AcpState): void => {
      try {
        const result = deriveAcpAnnouncements(acpMemory, state, readContext(state))
        acpMemory = result.memory
        const { announce } = useShellAnnouncerStore.getState()
        for (const text of result.announcements) announce(text)
      } catch (error) {
        // A throwing subscriber must never propagate into the caller's set().
        logEvaluationFailure('acp', error)
      }
    }

    const evaluateConnection = (state: ConnectionAnnouncementState): void => {
      try {
        const result = deriveConnectionAnnouncements(connectionMemory, state)
        connectionMemory = result.memory
        const { announce } = useShellAnnouncerStore.getState()
        for (const text of result.announcements) announce(text)
      } catch (error) {
        logEvaluationFailure('connection', error)
      }
    }

    evaluateAcp(useAcpStore.getState())
    evaluateConnection(useConnectionStatusStore.getState())

    const unsubscribeAcp = useAcpStore.subscribe((state, prev) => {
      if (acpSlicesUnchanged(state, prev)) return
      evaluateAcp(state)
    })
    const unsubscribeConnection = useConnectionStatusStore.subscribe((state, prev) => {
      if (
        state.controlChannel === prev.controlChannel &&
        state.terminalChannel === prev.terminalChannel
      ) {
        return
      }
      evaluateConnection(state)
    })

    return () => {
      unsubscribeAcp()
      unsubscribeConnection()
      unregisterRegion()
    }
  }, [])
}
