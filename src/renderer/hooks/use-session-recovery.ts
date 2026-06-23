import type { RecoveredSessionInfo } from '@shared/types/ipc.types'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { terminalApi } from '@/lib/api'
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

/**
 * On startup, ask the supervisor daemon for any sessions that survived a
 * previous Termul run and surface a recovery indicator. This does not yet
 * reattach the live xterm buffers (the renderer terminal path is not daemon
 * backed); it confirms survivors exist so the user knows background CLIs are
 * still running.
 */
export function useSessionRecovery(): void {
  const checked = useRef(false)

  useEffect(() => {
    if (checked.current) {
      return
    }
    checked.current = true

    let cancelled = false
    void (async () => {
      try {
        const result = await terminalApi.listRecoveredSessions()
        if (cancelled || !result.success) {
          return
        }
        const live = result.data.filter((s) => s.status === 'running' || s.status === 'detached')
        if (live.length > 0) {
          toast.info(
            live.length === 1
              ? '1 background session is still running'
              : `${live.length} background sessions are still running`,
            {
              description: 'Recovered from the session supervisor after restart.'
            }
          )
        }
      } catch {
        // Daemon unreachable or unsupported platform: no indicator.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])
}
