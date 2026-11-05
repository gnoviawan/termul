import { UNASSIGNED_PROJECT_ID } from '@shared/types/web-projects.types'
import type { ChatActivityRecord } from '@shared/types/web-protocol.types'
import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import type { SessionStatus } from '@/stores/acp-store'
import { isResumeFailureError } from '@/stores/acp-store/helpers'

/**
 * A `closed` Session that cannot resume by itself: its resume failed, or Codex
 * signed out. A cleanly stopped chat (idle reaper, Closing) resumes when the
 * user types, so it does not need the user.
 */
function closedSessionCannotResume(lastError: string | null): boolean {
  return isResumeFailureError(lastError) || lastError === CODEX_CLI_SIGNED_OUT_MESSAGE
}

/** The parts of this renderer's Session record a chat's status reads. */
export interface LocalChatSession {
  projectId: string
  status: SessionStatus
  lastError?: string | null
}

/**
 * One chat's Needs you: the host holds a permission, question or elicitation
 * of it, or, for a chat this renderer opened (`session`), its Agent
 * disconnected or it is closed and cannot resume by itself. A cleanly stopped
 * chat is not Needs you, and neither is a finished turn, including one that
 * ended in an error. Every chat list row, project count and announcement
 * reads this, so a chat never reads differently in two places.
 */
export function chatNeedsYou(
  activity: ChatActivityRecord | undefined,
  session: LocalChatSession | undefined,
  agentStatus: string | undefined
): boolean {
  if (activity?.needsYou) return true
  if (!session || session.projectId.length === 0) return false
  if (session.status === 'closed' && closedSessionCannotResume(session.lastError ?? null)) {
    return true
  }
  return agentStatus === 'disconnected'
}

/**
 * The chat's project: the host's record names it, this renderer's Session is
 * the fallback. The host's unassigned sentinel names no project.
 */
export function chatProjectId(
  activity: ChatActivityRecord | undefined,
  session: LocalChatSession | undefined
): string | undefined {
  const projectId = activity?.projectId || session?.projectId
  return projectId && projectId !== UNASSIGNED_PROJECT_ID ? projectId : undefined
}

/** A connected Agent chat with no turn in progress. The activity spinner covers a live turn. */
export function agentChatIsRunning(input: {
  projectId: string
  sessionStatus: SessionStatus
  agentStatus: string | undefined
  activeTurn: boolean
  ephemeral: boolean
}): boolean {
  if (input.ephemeral || input.projectId.length === 0) return false
  if (input.activeTurn) return false
  if (input.sessionStatus === 'closed' || input.sessionStatus === 'error') return false
  return input.agentStatus === 'connected'
}

export function needsYouLabel(count: number): string {
  return count === 1 ? '1 needs you' : `${count} need you`
}
