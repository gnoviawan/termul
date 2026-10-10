import { useCallback, useState } from 'react'
import type { SessionId } from '@/lib/acp-api'
import { permissionDeniedMessage } from '@/lib/permission-denial'
import { useAcpStore } from '@/stores/acp-store'

export interface PermissionDenialNoticeLine {
  /** The line to show, or null when there is no notice or it was dismissed. */
  message: string | null
  /** Hide the current notice. A later denial (another request id) shows again. */
  dismiss: () => void
}

/**
 * The denied-by-disconnect line for one chat (L-09). The store owns the notice
 * (`permissionDenialNotices`, set by `attachPermissionDenialTracking`, cleared
 * when the next turn starts or the session goes away). Dismiss is local to the
 * panel and keyed by request id, so it never hides a newer denial and needs no
 * store action.
 */
export function usePermissionDenialNotice(sessionId: SessionId): PermissionDenialNoticeLine {
  // `?.` guard: some suites mock the acp-store as a partial shape.
  const notice = useAcpStore((s) => s.permissionDenialNotices?.[sessionId] ?? null)
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null)
  const requestId = notice?.requestId ?? null
  const dismiss = useCallback(() => {
    if (requestId !== null) setDismissedRequestId(requestId)
  }, [requestId])
  const message =
    notice && notice.requestId !== dismissedRequestId ? permissionDeniedMessage(notice.tool) : null
  return { message, dismiss }
}
