/**
 * Pure data for the Side panel Chats list (shell revamp CAP-3): scope by the
 * worktree pick, newest-first order, the branch line and the search filter.
 * No React, no stores: callers pass the index, the project and the pick.
 */
import type { ProjectChatEntry } from '@/components/sidebar/project-chat-row'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { foldEntries, membersOf, sessionChainIndex } from '@/lib/session-chain'
import { pickedWorkingCopy, workingCopyOf } from '@/lib/working-copy'
import type { Project } from '@/types/project'

type ProjectScope = Pick<Project, 'path' | 'worktrees' | 'gitBranch' | 'isGitRepo'>

export interface ChatCardData {
  entry: ProjectChatEntry
  /** Configured agent name, or `null` when the config is gone. */
  agentName: string | null
  /** Model display name recorded in the session index, when known. */
  indexModel: string | null
  /** Branch line text; empty when the project has no git. */
  branch: string
}

/**
 * Branch shown on line 3 of a card. A chat inside a listed worktree shows that
 * worktree's branch (fallback: the stored branch); a chat whose worktree is
 * unlisted or unresolved shows the stored branch; any other chat shows the
 * project's current branch. A project without git shows nothing.
 */
export function branchLineOf(
  entry: Pick<SessionIndexEntry, 'cwd' | 'worktreePath' | 'worktreeBranch'>,
  project: ProjectScope
): string {
  if (project.isGitRepo === false) return ''
  const copy = workingCopyOf(entry.cwd, project)
  if (copy?.state === 'resolved' && copy.kind === 'worktree') {
    const worktree = (project.worktrees ?? []).find((w) => w.id === copy.worktreeId)
    return worktree?.branch || entry.worktreeBranch || ''
  }
  if (entry.worktreePath || copy?.state === 'unresolved') return entry.worktreeBranch ?? ''
  return project.gitBranch ?? ''
}

interface BuildChatCardsInput {
  sessionIndex: readonly SessionIndexEntry[]
  project: ProjectScope & { id: string }
  /** Canonical worktree path picked in the switcher (never written here). */
  pick: string | null | undefined
  /** Configured agent names by config id. */
  agentNames: ReadonlyMap<string, string>
}

/**
 * Cards for the active project: Troupe-created chats only, scoped by the pick
 * (a picked worktree keeps its own chats; Workspace keeps all of them), newest
 * activity first with the id as the tie-break.
 */
export function buildChatCards({
  sessionIndex,
  project,
  pick,
  agentNames
}: BuildChatCardsInput): ChatCardData[] {
  const picked = pickedWorkingCopy(project, pick)
  const narrowKey = picked?.state === 'resolved' && picked.kind === 'worktree' ? picked.key : null

  // CAP-8 (spec-in-chat-agent-switch): scope first, then fold every
  // `continuedFrom` chain to its terminal session — a handed-off chat is one
  // row, opened/reloaded on the live session, deleted as a whole via
  // `chainIds`. Display membership derives from the picked scope (a chain
  // member outside it stays its own row), but DELETE membership resolves
  // against the whole project index so a folded card removes members beyond
  // the pick too — otherwise the out-of-scope member resurfaces standalone.
  const projectChats = sessionIndex.filter(
    (e) => e.projectId === project.id && e.discovered !== true
  )
  const scoped = projectChats.filter(
    (e) => narrowKey === null || workingCopyOf(e.cwd, project)?.key === narrowKey
  )
  const deleteIndex = sessionChainIndex(projectChats)

  return foldEntries(sessionChainIndex(scoped))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => {
      const members = membersOf(deleteIndex, e.id)
      return {
        entry: {
          id: e.id,
          title: e.title,
          messageCount: e.messageCount,
          status: e.status,
          discovered: false,
          agentId: e.agentId,
          agentConfigId: e.agentConfigId,
          agents: e.agents,
          chainIds: members.length > 1 ? members : undefined,
          lastActivityAt: e.lastActivityAt,
          cwd: e.cwd,
          canOpen: true
        },
        agentName: e.agentConfigId ? (agentNames.get(e.agentConfigId) ?? null) : null,
        indexModel: e.modelName || e.modelId || null,
        branch: branchLineOf(e, project)
      }
    })
}

/**
 * The text the card's first line shows when there is no live session model:
 * the host-recorded model, else the agent name, else the generic fallback.
 */
export function modelLineOf(card: Pick<ChatCardData, 'indexModel' | 'agentName'>): string {
  return card.indexModel || card.agentName || 'Agent'
}

/** Case-insensitive substring over title, agent name, branch line and the visible model line. */
export function filterChatCards(cards: ChatCardData[], query: string): ChatCardData[] {
  const q = query.trim().toLowerCase()
  if (q === '') return cards
  return cards.filter(
    (card) =>
      card.entry.title.toLowerCase().includes(q) ||
      (card.agentName?.toLowerCase().includes(q) ?? false) ||
      card.branch.toLowerCase().includes(q) ||
      modelLineOf(card).toLowerCase().includes(q)
  )
}
