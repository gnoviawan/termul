import { useEffect } from 'react'
import { useAcpRegistryCatalog } from '@/hooks/use-acp-registry-catalog'
import { logFrontendError } from '@/lib/log-api'

/** Minimum gap between background checks (mount storms must not hammer the CDN). */
const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000
/** Background re-check cadence (Q8: app start + every 24 hours). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Module-level last-successful-check timestamp (throttle seam). A failed check
 * does NOT advance it — the next mount/interval retries.
 */
let lastCheckAt = 0

/** Test-only: reset the throttle so each suite starts from a cold state. */
export function _resetAcpUpdateChecksForTesting(): void {
  lastCheckAt = 0
}

/**
 * Background Update Check scheduler (Q8/Q10): checks once on mount and then
 * every 24 hours while the app runs, throttled to one check per 30 minutes.
 * Failures are silent (logged, no toast) — a manual check in Settings still
 * surfaces errors. This NEVER applies anything: the check is advisory and the
 * Application step stays an explicit user action (ADR-0001).
 */
export function useAcpUpdateChecks(): void {
  const { checkForUpdates } = useAcpRegistryCatalog()

  useEffect(() => {
    let cancelled = false
    const run = (): void => {
      void (async () => {
        try {
          await checkForUpdates(true)
          if (!cancelled) lastCheckAt = Date.now()
        } catch (err) {
          if (!cancelled) {
            void logFrontendError({
              level: 'warn',
              source: 'useAcpUpdateChecks',
              message: `Background registry update check failed: ${err instanceof Error ? err.message : String(err)}`
            })
          }
        }
      })()
    }
    if (Date.now() - lastCheckAt >= MIN_CHECK_INTERVAL_MS) run()
    const interval = window.setInterval(() => {
      if (Date.now() - lastCheckAt >= MIN_CHECK_INTERVAL_MS) run()
    }, CHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [checkForUpdates])
}
