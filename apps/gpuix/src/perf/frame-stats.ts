import { appendFileSync } from 'node:fs'
import type { NativeRenderer } from '@gpuix/react'

/**
 * With `TERMUL_GPUIX_FRAME_STATS=<file>`, appends one JSON line a second: the
 * frames drawn so far and the draw times recorded since the last line, from
 * the debug frame overlay. The perf harness reads it to split UI-thread time
 * into frames per second and cost per frame.
 */
export function startFrameStats(renderer: NativeRenderer): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  const file = env?.TERMUL_GPUIX_FRAME_STATS
  if (!file || !renderer.getDebugFrameOverlayStats) return
  renderer.setDebugFrameOverlay?.('minimal')
  setInterval(() => {
    // The read waits at most 2s for the UI thread; a busier thread skips the sample.
    try {
      const stats = renderer.getDebugFrameOverlayStats?.()
      renderer.resetDebugFrameOverlayStats?.()
      appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...stats })}\n`)
    } catch {}
  }, 1000)
}
