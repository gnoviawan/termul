import path from 'node:path'
import type { Numbers } from './stats.ts'

/**
 * Screen updates from the X server, for frame timing that works the same for
 * every client and needs nothing inside it. `x-frames.py` prints one line per
 * DAMAGE event on a top-level window. A present can arrive as several
 * rectangles, so events closer than FRAME_GAP_MS are one frame.
 */
const FRAME_GAP_MS = 3

export interface ScreenLog {
  /** Frame start times (epoch ms) within [from, to]. */
  frames(from: number, to: number): number[]
  stop(): Promise<void>
}

export async function startScreenLog(display: string): Promise<ScreenLog> {
  const child = Bun.spawn(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      path.join(import.meta.dir, 'x-frames.py')
    ],
    { env: { ...process.env, DISPLAY: display }, stdout: 'pipe', stderr: 'inherit' }
  )
  const events: number[] = []
  const { promise: ready, resolve } = Promise.withResolvers<void>()
  const pump = (async () => {
    const decoder = new TextDecoder()
    let rest = ''
    const reader = child.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (line === 'ready') resolve()
        else events.push(Number(line.slice(0, line.indexOf(' '))))
      }
    }
  })()
  const timeout = setTimeout(() => resolve(), 15_000)
  await ready
  clearTimeout(timeout)
  return {
    frames: (from, to) => {
      const out: number[] = []
      let last = Number.NEGATIVE_INFINITY
      for (const t of events) {
        if (t < from || t > to) continue
        if (t - last >= FRAME_GAP_MS) out.push(t)
        last = t
      }
      return out
    },
    stop: async () => {
      child.kill()
      await pump.catch(() => undefined)
    }
  }
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : 0

/** Screen frame rate and the distribution of gaps between presented frames. */
export function summarizeScreen(frames: number[], windowMs: number): Numbers {
  const gaps = frames
    .slice(1)
    .map((t, i) => t - frames[i])
    .sort((a, b) => a - b)
  const r = (v: number) => Math.round(v * 10) / 10
  return {
    'screen.frames': frames.length,
    'screen.fps': r(frames.length / (windowMs / 1000)),
    'screen.gapP50Ms': r(pct(gaps, 0.5)),
    'screen.gapP95Ms': r(pct(gaps, 0.95)),
    'screen.gapP99Ms': r(pct(gaps, 0.99)),
    'screen.gapMaxMs': r(gaps[gaps.length - 1] ?? 0),
    'screen.gapsOver50Ms': gaps.filter((g) => g > 50).length
  }
}
