/**
 * Host-offline detection shared by the three web sockets (`/ws`,
 * `/terminal/ws`, persistence).
 *
 * A host that stops on purpose closes every socket with `Close(1001)`. That
 * is not a network fault: the host will not answer until someone starts it
 * again, so a backoff reconnect loop only burns battery and fills the log.
 * The client enters a `host-offline` state instead, asks `GET /health` at a
 * slow cadence (and on a user retry, a wake or a network-online signal), and
 * reconnects once the host answers.
 */

import { authHeader } from '../web-auth-token'

/** WebSocket close code the host sends when it stops (`CLOSE_GOING_AWAY`). */
export const HOST_GOING_AWAY_CLOSE_CODE = 1001

/** Cadence of the slow health probe while the host is offline. */
export const HOST_OFFLINE_PROBE_INTERVAL_MS = 15_000

/** Budget of one health request. */
export const HOST_OFFLINE_PROBE_TIMEOUT_MS = 5_000

/** Ask the host `GET /health`. True when it answers with a 2xx status. */
export async function probeHostHealth(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HOST_OFFLINE_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${window.location.origin}/health`, {
      method: 'GET',
      headers: authHeader(),
      cache: 'no-store',
      signal: controller.signal
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Slow health probe for one socket. `start` arms it, `probeNow` asks at once
 * (user retry, wake, online), `stop` disarms it. When the host answers the
 * monitor stops itself and calls `onOnline` once.
 */
export class HostOfflineMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private inFlight = false
  /** Bumped by `stop` so an answer that arrives after a stop is ignored. */
  private generation = 0

  constructor(
    private readonly onOnline: () => void,
    private readonly intervalMs = HOST_OFFLINE_PROBE_INTERVAL_MS
  ) {}

  get active(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    this.generation += 1
    this.inFlight = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  probeNow(): void {
    if (!this.running) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    void this.probe()
  }

  private schedule(): void {
    if (!this.running || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.probe()
    }, this.intervalMs)
  }

  private async probe(): Promise<void> {
    if (!this.running || this.inFlight) return
    this.inFlight = true
    const generation = this.generation
    const online = await probeHostHealth()
    if (generation !== this.generation) return
    this.inFlight = false
    if (!this.running) return
    if (online) {
      this.stop()
      this.onOnline()
      return
    }
    this.schedule()
  }
}
