import { useEffect, useState } from 'react'

/**
 * Grace period before a transient connection state (the transport
 * "Reconnecting…" overlay, the AD-6 "Waiting to confirm" pill) is shown. A
 * reconnect on returning to the tab usually settles in about 300 ms; a real
 * outage still shows within a second.
 */
export const RECONNECT_GRACE_MS = 1000

/**
 * Returns true only after `flag` has stayed true for `ms` milliseconds, and
 * false at once (same render) when `flag` drops. A flag that flips back to
 * false before the delay elapses never surfaces.
 */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false)

  useEffect(() => {
    if (!flag) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), ms)
    return () => clearTimeout(timer)
  }, [flag, ms])

  return flag && elapsed
}
