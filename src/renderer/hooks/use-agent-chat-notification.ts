import { useEffect } from 'react'
import {
  type AgentChatNotifyEvent,
  type AgentChatNotifySnapshot,
  decideAgentChatNotifications
} from '@/lib/agent-chat-notify'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { sanitizeNotificationText } from './use-terminal-exit-notification'

function windowIsFocused(): boolean {
  if (typeof document !== 'undefined' && typeof document.hasFocus === 'function') {
    return document.hasFocus()
  }
  return true
}

function readSnapshot(): AgentChatNotifySnapshot {
  const acp = useAcpStore.getState()
  const settings = useAppSettingsStore.getState().settings
  const sessions: AgentChatNotifySnapshot['sessions'] = {}
  for (const [sessionId, session] of Object.entries(acp.sessions ?? {})) {
    const notice = acp.turnEndNotices?.[sessionId]
    sessions[sessionId] = {
      projectId: session.projectId,
      ephemeral: isEphemeralAcpSession(sessionId),
      busy: sessionTurnBusy(session),
      queueLength: acp.promptQueues?.[sessionId]?.length ?? 0,
      turnEndSeq: notice?.seq ?? 0,
      stopReason: notice?.stopReason ?? null
    }
  }
  const activeTab = useWorkspaceStore.getState().getActiveTab()
  const viewingSessionId =
    windowIsFocused() && activeTab?.type === 'agent-chat' ? activeTab.sessionId : null
  return {
    sessions,
    permissions: Object.values(acp.pendingPermissions ?? {}).map((item) => ({
      id: item.requestId,
      sessionId: item.sessionId
    })),
    questions: Object.values(acp.pendingQuestions ?? {}).map((item) => ({
      id: item.questionId,
      sessionId: item.sessionId
    })),
    viewingSessionId,
    notifyTurnFinished: settings.notifyOnAgentChatTurnFinished,
    notifyNeedsYou: settings.notifyOnAgentChatNeedsYou
  }
}

function notificationCopy(event: AgentChatNotifyEvent): { title: string; body: string } {
  const acp = useAcpStore.getState()
  const session = acp.sessions[event.sessionId]
  const indexed = acp.sessionIndex.find((entry) => entry.id === event.sessionId)
  const project = useProjectStore.getState().projects.find((item) => item.id === session?.projectId)
  const title = sanitizeNotificationText(project?.name ?? 'Termul')
  const chat = sanitizeNotificationText(session?.title || indexed?.title || 'Agent Chat')
  const suffix =
    event.kind === 'turn-finished'
      ? 'finished'
      : event.kind === 'needs-approval'
        ? 'needs approval'
        : 'has a question'
  return { title, body: `${chat} — ${suffix}` }
}

/**
 * Notify when an Agent Chat turn finishes, or when a permission or question
 * is waiting, unless the user is already looking at that chat.
 */
export function useAgentChatNotification(): void {
  useEffect(() => {
    let prev: AgentChatNotifySnapshot | null = null

    const emit = (): void => {
      const next = readSnapshot()
      const events = decideAgentChatNotifications(prev, next)
      prev = next
      for (const event of events) {
        const copy = notificationCopy(event)
        void sendDesktopNotification(copy.title, copy.body)
      }
    }

    emit()
    const unsubscribeAcp = useAcpStore.subscribe(emit)
    const unsubscribeWorkspace = useWorkspaceStore.subscribe(emit)
    const unsubscribeSettings = useAppSettingsStore.subscribe(emit)
    return () => {
      unsubscribeAcp()
      unsubscribeWorkspace()
      unsubscribeSettings()
    }
  }, [])
}
