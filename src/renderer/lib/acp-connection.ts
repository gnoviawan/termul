import type { SessionSnapshotEvent } from '@shared/types/web-protocol.types'
import type { SessionId } from '@/lib/acp-api'
import type { AcpTransport } from '@/lib/acp-transport'

export type AcpRecovery = SessionSnapshotEvent | { sessionId: string; degraded: true }

export interface AcpConnectionCoordinatorOptions {
  installRecovery: (recovery: AcpRecovery, reopenGeneration?: number) => Promise<void>
  /**
   * Store's per-session reopen generation (0 when never reopened). The
   * transport captures it before the recovery round-trip and hands it back
   * to `installRecovery` so a late recovery for a torn-down or replaced
   * session is rejected.
   */
  recoveryGeneration?: (sessionId: SessionId) => number
  pendingPermissionSessions: () => SessionId[]
  setReconnecting: (reconnecting: boolean) => void
}

/**
 * Thin policy decorator above the transport. Socket framing stays in
 * `WsAcpTransport`; transcript installation stays store-owned.
 */
export class AcpConnectionCoordinator {
  constructor(
    private readonly transport: AcpTransport,
    private readonly options: AcpConnectionCoordinatorOptions
  ) {}

  attach(): void {
    this.transport.setReconnectListener?.(this.options.setReconnecting)
    this.transport.setReconnectPriorityProvider?.(this.options.pendingPermissionSessions)
    this.transport.setRecoveryHandler?.(this.options.installRecovery)
    if (this.options.recoveryGeneration) {
      this.transport.setRecoveryGenerationProvider?.(this.options.recoveryGeneration)
    }
  }
}
