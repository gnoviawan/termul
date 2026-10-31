/**
 * Post-apply restart handoff for the web onboarding / reconfigure wizard
 * (gh-1105).
 *
 * `POST /setup/apply` (and `POST /server/config`) replies `{host, port,
 * webAuthToken?}` and the server re-execs ~400ms later on the NEW bind. The
 * old origin dies with it, so this screen polls `http://<host>:<port>/health`
 * until the restarted server answers — `fetch(url, {mode:'no-cors'})`
 * resolves on ANY HTTP response, no CORS needed — then navigates the browser
 * to the new origin. When the reply carried a `webAuthToken` (non-loopback
 * bind) it is appended as `#token=<token>` — the same URL-fragment landing
 * convention `web-auth-token.ts` resolves and strips — so the client arrives
 * authenticated.
 *
 * Two edge cases:
 * - Unchanged host/port: the computed target IS the current origin — the
 *   poll still waits for the restarted /health before reloading, which also
 *   covers the same-port reconfigure path.
 * - Wildcard bind (`0.0.0.0`): not a browsable address. The page was already
 *   loaded from a reachable hostname, so the poll/redirect reuse it.
 *
 * After {@link SLOW_AFTER_MS} without an answer the screen keeps polling but
 * also offers the new address as a manual link (the "dead origin" state from
 * the spec's edge matrix — e.g. a remote browser that picked a loopback-only
 * bind it can never reach).
 *
 * Rendered `fixed` over the whole viewport so the same component covers the
 * full-screen setup flow and the settings modal in reconfigure mode.
 */

import { useEffect, useMemo, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'

export interface RestartingScreenProps {
  /** Effective bind host the server will listen on after restart. */
  host: string
  /** Effective bind port the server will listen on after restart. */
  port: number
  /** Present when the restart bind is non-loopback and the server issued a token. */
  webAuthToken?: string
}

/** First poll delay — the server re-execs ~400ms after replying to apply. */
export const RESTART_FIRST_POLL_MS = 500
/** Interval between health probes. */
export const RESTART_POLL_INTERVAL_MS = 750
/** How long to wait before offering the manual "open it yourself" link. */
export const RESTART_SLOW_AFTER_MS = 30_000

/** True for bind wildcards that are never a browsable destination. */
function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '0.0.0.0' || h === '::' || h === '[::]' || h === 'all' || h === 'any'
}

/**
 * The hostname to poll/redirect to for a given bind host. A wildcard bind
 * listens on every interface — including the hostname this page was already
 * loaded from — so that hostname is the reachable address.
 */
export function restartTargetHost(host: string): string {
  if (!isWildcardHost(host)) return host.trim()
  if (typeof window !== 'undefined' && window.location?.hostname) {
    return window.location.hostname
  }
  return '127.0.0.1'
}

/** `http://host:port` — the origin the restarted server will serve. */
export function restartTargetOrigin(host: string, port: number): string {
  return `http://${restartTargetHost(host)}:${port}`
}

/** The `/health` URL polled until the restarted server answers. */
export function restartHealthUrl(host: string, port: number): string {
  return `${restartTargetOrigin(host, port)}/health`
}

/**
 * Where the browser lands once the server answers. A carried `webAuthToken`
 * rides the `#token=` fragment convention (stripped into localStorage on
 * load — never in the query string, so it can't leak via logs or Referer).
 */
export function restartLandingUrl(host: string, port: number, webAuthToken?: string): string {
  const origin = restartTargetOrigin(host, port)
  return webAuthToken ? `${origin}/#token=${encodeURIComponent(webAuthToken)}` : `${origin}/`
}

export function RestartingScreen({ host, port, webAuthToken }: RestartingScreenProps) {
  const [slow, setSlow] = useState(false)
  const healthUrl = useMemo(() => restartHealthUrl(host, port), [host, port])
  const landingUrl = useMemo(
    () => restartLandingUrl(host, port, webAuthToken),
    [host, port, webAuthToken]
  )
  const targetOrigin = useMemo(() => restartTargetOrigin(host, port), [host, port])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = Date.now() + RESTART_SLOW_AFTER_MS
    const poll = (): void => {
      if (cancelled) return
      void fetch(healthUrl, { mode: 'no-cors' })
        .then(() => {
          if (cancelled) return
          window.location.assign(landingUrl)
        })
        .catch(() => {
          // Any rejection (connection refused while the process re-execs, DNS
          // hiccup) means "not up yet" — keep polling.
          if (cancelled) return
          if (Date.now() >= deadline) setSlow(true)
          timer = setTimeout(poll, RESTART_POLL_INTERVAL_MS)
        })
    }
    timer = setTimeout(poll, RESTART_FIRST_POLL_MS)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [healthUrl, landingUrl])

  return (
    <div className="fixed inset-0 z-[110] flex flex-col items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <Spinner size={24} label="Restarting" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold text-foreground">Restarting Termul</h1>
          <p className="text-sm text-muted-foreground">
            The server is coming back on its new address. You'll be taken there automatically — this
            usually takes a few seconds.
          </p>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{targetOrigin}</p>
        {slow ? (
          <p className="text-sm text-muted-foreground">
            This is taking longer than usual. You can{' '}
            <a href={landingUrl} className="text-primary underline underline-offset-4">
              open the new address
            </a>{' '}
            yourself — this page keeps trying too.
          </p>
        ) : null}
      </div>
    </div>
  )
}
