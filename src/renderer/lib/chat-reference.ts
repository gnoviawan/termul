import { copyTextWithToast } from '@/lib/copy-text'
import { useAcpStore } from '@/stores/acp-store'
import { sessionProjectId } from '@/stores/acp-store/helpers'
import { useProjectStore } from '@/stores/project-store'

/**
 * What another chat's agent needs to read this chat: its id, which the host
 * `read_chat` tool takes, and where it ran.
 */
export interface ChatReference {
  chatId: string
  title: string
  /** `name` is dropped when the registry no longer knows the id. */
  project?: { id: string; name?: string }
  cwd?: string
}

const READ_HINT = 'Read it with the Troupe read_chat tool.'

/**
 * A short labeled plain-text block ending in how to read the chat; lines with
 * an unknown value are left out.
 */
export function formatChatReference({ chatId, title, project, cwd }: ChatReference): string {
  const lines = [`Troupe chat: ${title.replace(/\s+/g, ' ').trim()}`, `Chat ID: ${chatId}`]
  if (project) {
    const name = project.name?.replace(/\s+/g, ' ').trim()
    lines.push(name ? `Project: ${name} (ID ${project.id})` : `Project: ID ${project.id}`)
  }
  if (cwd) lines.push(`Folder: ${cwd}`)
  lines.push(READ_HINT)
  return lines.join('\n')
}

/**
 * The reference of one chat from the stores at call time: the live session
 * first, then its index entry. An open chat can belong to another project than
 * the active one, so the project comes from the chat, never from the view.
 * The id stays even when the project's name is gone (a removed project); the
 * host's unassigned sentinel names no project.
 */
export function resolveChatReference(chatId: string, title: string): ChatReference {
  const state = useAcpStore.getState()
  const projectId = sessionProjectId(state, chatId)
  const named = projectId
    ? useProjectStore.getState().projects.find((p) => p.id === projectId)
    : undefined
  const { sessions, sessionIndex } = state
  return {
    chatId,
    title,
    project: projectId ? { id: projectId, name: named?.name } : undefined,
    cwd: sessions?.[chatId]?.cwd || sessionIndex?.find((e) => e.id === chatId)?.cwd || undefined
  }
}

export function copyChatReference(
  chatId: string,
  title: string,
  logSource: string
): Promise<boolean> {
  return copyTextWithToast(formatChatReference(resolveChatReference(chatId, title)), {
    title: 'Chat reference copied',
    description: chatId,
    failureTitle: 'Failed to copy chat reference',
    logSource
  })
}
