import { useMemo } from 'react'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { foldEntries, membersOf, sessionChainIndex } from '@/lib/session-chain'
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

export function projectConversations({
  sessionIndex,
  projectId,
  excludeSessionId,
  agentNames,
  runningIds
}: ProjectConversationsInput): ConversationMatch[] {
  if (!projectId) return []
  // Scope BEFORE chaining: folding over the whole index would let a
  // cross-project `continuedFrom` edge hide a source that still belongs to
  // this project's list (and chain the exclusion past the scope).
  const scoped = sessionIndex.filter((e) => e.projectId === projectId && e.discovered !== true)
  // A switched conversation is mentionable once — the folded terminal row
  // opens the merged transcript (CAP-8 / spec-in-chat-agent-switch). The
  // exclusion covers every chain member: a composer open on a pre-switch
  // source or an intermediate hop must not list its own merged conversation.
  const chain = sessionChainIndex(scoped)
  return foldEntries(chain)
    .filter(
      (e) =>
        excludeSessionId === undefined ||
        excludeSessionId === null ||
        !membersOf(chain, e.id).includes(excludeSessionId)
    )
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

function selectRunningKey(state: ReturnType<typeof useAcpStore.getState>): string {
  const ids: string[] = []
  for (const [id, session] of Object.entries(state.sessions)) {
    if (session?.activeTurn || session?.openTurnId) ids.push(id)
  }
  return ids.sort().join('\n')
}

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
