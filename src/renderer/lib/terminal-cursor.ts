/**
 * The `logEpoch` to present with a terminal replay cursor.
 *
 * A nonzero cursor is only meaningful against the log epoch it was issued
 * under. When no epoch is known the empty string goes out: no real epoch
 * equals it, so the host replays the whole retained log with `reset` instead
 * of trusting the cursor. A zero cursor needs no epoch.
 */
export function terminalCursorEpoch(
  lastSeq: number,
  logEpoch: string | undefined
): string | undefined {
  if (logEpoch) return logEpoch
  return lastSeq > 0 ? '' : undefined
}
