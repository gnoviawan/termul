import { useMemo } from 'react'
import type { ProjectChatLiveState } from '@/components/sidebar/project-chat-row'
import {
  type AgentChatStatusSignals,
  useAgentChatStatusSignals
} from '@/components/workspace/tabs/agent-chat-status'
import { useAcpStore } from '@/stores/acp-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { buildChatCards, type ChatCardData } from './chat-cards'

/** Accessible status word of each live state; idle has none. */
export const CHAT_STATUS_WORD: Record<ProjectChatLiveState, string | null> = {
  'needs-you': 'Needs you',
  running: 'Running',
  done: 'New activity',
  idle: null
}

/** Session id of the agent chat tab focused in the active pane, if any. */
export function useOpenChatSessionId(): string | null {
  return useWorkspaceStore((s) => {
    const pane = findPaneById(s.root, s.activePaneId)
    if (pane?.type !== 'leaf') return null
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId)
    return tab?.type === 'agent-chat' ? tab.sessionId : null
  })
}

/**
 * True when `card` is the open chat: its own session, or any session of its
 * folded `continuedFrom` chain.
 */
export function isOpenChatCard(card: ChatCardData, openChatId: string | null): boolean {
  if (openChatId === null) return false
  return card.entry.id === openChatId || (card.entry.chainIds?.includes(openChatId) ?? false)
}

export interface ProjectChats {
  /** The project's chats, scoped by the worktree pick, newest first. */
  cards: ChatCardData[]
  /** Session id of the chat open in the active pane, or `null`. */
  openChatId: string | null
}

/**
 * Chats of one project for the Rail and the Chats list: the same cards
 * `buildChatCards` makes from the session index, scoped by the project's
 * worktree pick, plus the open chat id. Live state is per chat: read it with
 * {@link useChatLiveState} in each row.
 */
export function useProjectChats(project: Project): ProjectChats {
  const sessionIndex = useAcpStore((s) => s.sessionIndex)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const pick = useShellLayoutStore((s) => s.worktreePickByProject[project.id])
  const openChatId = useOpenChatSessionId()

  const agentNames = useMemo(
    () => new Map(agentConfigs.map((config) => [config.id, config.name])),
    [agentConfigs]
  )
  const cards = useMemo(
    () => buildChatCards({ sessionIndex, project, pick, agentNames }),
    [sessionIndex, project, pick, agentNames]
  )
  return { cards, openChatId }
}

/** Maps the host-owned chat signals to one row state, needs-you first. */
export function liveStateOf(
  signals: Pick<AgentChatStatusSignals, 'needsAttention' | 'turnBusy' | 'unread'>
): ProjectChatLiveState {
  if (signals.needsAttention) return 'needs-you'
  if (signals.turnBusy) return 'running'
  if (signals.unread) return 'done'
  return 'idle'
}

export interface ChatLiveState {
  liveState: ProjectChatLiveState
  /** Status word for the accessible name, `null` when idle. */
  statusWord: string | null
  signals: AgentChatStatusSignals
}

/**
 * Live state of one chat from the same signals as its tab, so a row and the
 * tab always agree.
 */
export function useChatLiveState(sessionId: string): ChatLiveState {
  const signals = useAgentChatStatusSignals(sessionId)
  const liveState = liveStateOf(signals)
  return { liveState, statusWord: CHAT_STATUS_WORD[liveState], signals }
}
