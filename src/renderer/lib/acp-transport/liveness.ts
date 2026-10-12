/**
 * Host liveness from the frames the host sends, not from a ping round trip.
 *
 * The host writes a `heartbeat` frame every {@link HOST_HEARTBEAT_INTERVAL_MS}
 * straight to the socket, even while its outbound queue is busy. ANY host frame
 * (reply, event, heartbeat) proves the link is alive; no frame for
 * {@link HOST_SILENCE_LIMIT_MS} means the link is half-open or the host is
 * wedged, and the transport probes it and then reconnects.
 */

/** Mirrors the host's `HEARTBEAT_INTERVAL` (`ws/relay/watchdog.rs`). */
export const HOST_HEARTBEAT_INTERVAL_MS = 10_000
/** Silence tolerated, in heartbeat intervals. */
export const HOST_SILENCE_FACTOR = 2.5
export const HOST_SILENCE_LIMIT_MS = HOST_HEARTBEAT_INTERVAL_MS * HOST_SILENCE_FACTOR
/** How often the silence check runs. */
const CHECK_INTERVAL_MS = HOST_HEARTBEAT_INTERVAL_MS / 2

export class HostLiveness {
  private lastFrameAt = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: {
      /** The host has been silent past the limit. */
      onSilent: (silentMs: number) => void
      /** False while the page cannot judge (hidden tab: timers and frames are throttled). */
      canJudge?: () => boolean
      now?: () => number
    }
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** A host frame arrived. */
  touch(): void {
    this.lastFrameAt = this.now()
  }

  start(): void {
    this.stop()
    this.touch()
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private check(): void {
    if (this.deps.canJudge && !this.deps.canJudge()) {
      this.touch()
      return
    }
    const silentMs = this.now() - this.lastFrameAt
    if (silentMs <= HOST_SILENCE_LIMIT_MS) return
    // Re-arm before reporting so a slow probe is not reported again each tick.
    this.touch()
    this.deps.onSilent(silentMs)
  }
}
