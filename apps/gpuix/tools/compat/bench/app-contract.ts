/**
 * `#compat/bench-app`: the Bun-typed bench entry sees this contract, the
 * bundler sees `app.tsx` (typed with the DOM lib, like the client).
 */

import type { NativeRenderer } from '@gpuix/react'

export interface BenchHost {
  /** Set by `BENCH_PROFILE`: loop one phase with no sleeps, for a CPU profile. */
  profile: 'mount' | 'rerender' | null
  /** `BENCH_ITERATIONS`: profile loop length. */
  iterations: number | null
  sleep(ms: number): Promise<void>
  gc(): void
  rssBytes(): number
  /** CPU time of the JS thread, in microseconds: what contention on a shared host does not inflate. */
  cpuMicros(): number
  write(json: string): void
  exit(): void
}

export type RunBench = (
  mode: 'compat' | 'hand',
  host: BenchHost,
  onRenderer: (renderer: NativeRenderer) => void
) => void

export declare const runBench: RunBench
