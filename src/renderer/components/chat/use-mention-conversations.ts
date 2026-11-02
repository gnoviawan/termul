import { useMemo } from 'react'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { conversationTitleText } from '@/lib/skill-tokens'
import { useAcpStore } from '@/stores/acp-store'
import type { ConversationMatch } from './mention-menu-model'

interface ProjectConversationsInput {
  sessionIndex: readonly SessionIndexEntry[]
  projectId: string | null | undefined
  excludeSessionId: string | null | undefined
  agentNames: ReadonlyMap<string, string>
  runningIds: ReadonlySet<string>
}

/**
 * Every chat in the project, newest first, the way the Chats list orders
 * them but without its worktree narrowing. Discovered (not Termul-owned)
 * chats and the composer's own chat are left out. The web index spans all
 * projects, so the project filter matters there.
 */
export function projectConversations({
  sessionIndex,
  projectId,
  excludeSessionId,
  agentNames,
  runningIds
}: ProjectConversationsInput): ConversationMatch[] {
  if (!projectId) return []
  return sessionIndex
    .filter((e) => e.projectId === projectId && e.discovered !== true && e.id !== excludeSessionId)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      sessionId: e.id,
      title: conversationTitleText(e.title) || 'Untitled chat',
      agentName: e.agentConfigId ? (agentNames.get(e.agentConfigId) ?? null) : null,
      lastActivityAt: e.lastActivityAt,
      running: runningIds.has(e.id)
    }))
}

const NO_ENTRIES: SessionIndexEntry[] = []
const NO_CONFIGS: ReturnType<typeof useAcpStore.getState>['agentConfigs'] = []

/** Running ids as one string so the selector only re-renders when the set changes. */
function selectRunningKey(state: ReturnType<typeof useAcpStore.getState>): string {
  const ids: string[] = []
  for (const [id, session] of Object.entries(state.sessions)) {
    // Desktop index rows never carry `turnActive`; the live session does.
    if (session?.activeTurn || session?.openTurnId) ids.push(id)
  }
  return ids.sort().join('\n')
}

/** Subscribes only while `enabled` (the menu is open), so a closed composer never re-renders on index churn. */
export function useMentionConversations(
  enabled: boolean,
  projectId: string | null | undefined,
  excludeSessionId: string | null | undefined
): ConversationMatch[] {
  const sessionIndex = useAcpStore((s) => (enabled ? s.sessionIndex : NO_ENTRIES))
  const agentConfigs = useAcpStore((s) => (enabled ? s.agentConfigs : NO_CONFIGS))
  const runningKey = useAcpStore((s) => (enabled ? selectRunningKey(s) : ''))
  return useMemo(
    () =>
      projectConversations({
        sessionIndex,
        projectId,
        excludeSessionId,
        agentNames: new Map(agentConfigs.map((c) => [c.id, c.name])),
        runningIds: new Set(runningKey === '' ? [] : runningKey.split('\n'))
      }),
    [sessionIndex, agentConfigs, runningKey, projectId, excludeSessionId]
  )
}
