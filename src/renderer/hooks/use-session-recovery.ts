import type { RecoveredSessionInfo } from '@shared/types/ipc.types'
import type { Terminal } from '@/types/project'

export function mapRecoveredTerminalToStorePatch(session: RecoveredSessionInfo): Partial<Terminal> {
  return {
    ptyId: session.sessionId,
    recoveredSessionId: session.sessionId,
    shell: session.shell ?? 'shell',
    cwd: session.cwd ?? undefined,
    lastExitCode: session.exitCode ?? null,
    recoveryStatus:
      session.status === 'running' || session.status === 'detached'
        ? 'live_attachable'
        : session.status === 'lost'
          ? 'lost'
          : 'restored',
    recoveryReason: session.recoveryReason ?? undefined
  }
}
