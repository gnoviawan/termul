/**
 * `visible_at` gate (AD-6). The host stamps an ok reply of a session-scoped
 * command with the session seq at which its effect became visible. A client
 * that shows the created/reopened entity before its event stream has reached
 * that seq would paint a half-built session, so the UI waits until the
 * transport's session cursor has caught up (bounded: a stalled stream must not
 * hang the caller, the replay path delivers the rest).
 *
 * Only a WS transport has a cursor accessor to compare: with no accessor
 * (desktop) or no `visible_at` the entity is visible on reply. With an accessor
 * a `null` cursor (no event seen yet) is NOT visible — it waits, bounded.
 */

import { logFrontendError } from './log-api'

export const VISIBLE_AT_POLL_MS = 25
export const VISIBLE_AT_MAX_WAIT_MS = 3_000

/**
 * Resolve once `getCursor()` reaches `visibleAt`. Returns `true` when visible,
 * `false` when the bounded wait ran out (logged; the caller proceeds).
 */
export async function waitUntilVisible(
  getCursor: (() => number | null | undefined) | undefined,
  visibleAt: number | undefined,
  opts: { pollMs?: number; maxWaitMs?: number } = {}
): Promise<boolean> {
  // No cursor accessor = no stream to compare against (desktop, ephemeral).
  if (visibleAt === undefined || !getCursor) return true
  const pollMs = opts.pollMs ?? VISIBLE_AT_POLL_MS
  const deadline = Date.now() + (opts.maxWaitMs ?? VISIBLE_AT_MAX_WAIT_MS)
  for (;;) {
    // A null cursor on a stream that has one means "subscribed, no event yet":
    // the entity is not visible until the first events arrive.
    const cursor = getCursor() ?? null
    if (cursor !== null && cursor >= visibleAt) return true
    if (Date.now() >= deadline) {
      void logFrontendError({
        level: 'warn',
        source: 'command-visibility',
        message: `Session cursor ${cursor ?? 'none'} did not reach visible_at ${visibleAt} in time; showing the entity anyway`
      })
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }
}
