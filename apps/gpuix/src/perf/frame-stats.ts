import type { NativeRenderer } from '@gpuix/react'

interface Runtime {
  process?: { env?: Record<string, string | undefined> }
  Bun?: { file(path: string): { writer(): { write(chunk: string): void; flush(): void } } }
}

/**
 * With `TERMUL_GPUIX_FRAME_STATS=<file>`, appends one JSON line a second: the
 * frames drawn so far and the draw times recorded since the last line, from
 * the debug frame overlay. The perf harness reads it to split UI-thread time
 * into frames per second and cost per frame.
 */
export function startFrameStats(renderer: NativeRenderer): void {
  const { process, Bun } = globalThis as Runtime
  const file = process?.env?.TERMUL_GPUIX_FRAME_STATS
  if (!file || !Bun || !renderer.getDebugFrameOverlayStats) return
  const out = Bun.file(file).writer()
  renderer.setDebugFrameOverlay?.('minimal')
  setInterval(() => {
    // The read waits at most 2s for the UI thread; a busier thread skips the sample.
    try {
      const stats = renderer.getDebugFrameOverlayStats?.()
      renderer.resetDebugFrameOverlayStats?.()
      out.write(`${JSON.stringify({ t: Date.now(), ...stats })}\n`)
      out.flush()
    } catch {}
  }, 1000)
}
