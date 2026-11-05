import type { BackgroundCommand } from '@/lib/acp-api'
import type { AcpSession } from '@/stores/acp-store/types'

const NONE: readonly BackgroundCommand[] = []

/**
 * The commands the chat's agent left running, oldest first. Empty for a
 * closed or crashed chat (its process is gone, and the commands with it) and
 * for a list reported by an agent the chat no longer runs on.
 */
export function sessionBackgroundCommands(
  session: Pick<AcpSession, 'agentId' | 'status' | 'backgroundCommands'> | undefined
): readonly BackgroundCommand[] {
  if (!session?.backgroundCommands) return NONE
  if (session.status === 'closed' || session.status === 'error') return NONE
  if (session.backgroundCommands.agentId !== session.agentId) return NONE
  return session.backgroundCommands.commands
}

export function runningBackgroundCommands(
  session: Pick<AcpSession, 'agentId' | 'status' | 'backgroundCommands'> | undefined
): number {
  return sessionBackgroundCommands(session).filter((command) => command.state === 'running').length
}
