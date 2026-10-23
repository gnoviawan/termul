/**
 * `#compat/bench-app`: the Bun-typed bench entry sees this contract, the
 * bundler sees `app.tsx` (typed with the DOM lib, like the client).
 */

import type { NativeRenderer } from '@gpuix/react'

export interface BenchHost {
  sleep(ms: number): Promise<void>
  gc(): void
  rssBytes(): number
  write(json: string): void
  exit(): void
}

export type RunBench = (
  mode: 'compat' | 'hand',
  host: BenchHost,
  onRenderer: (renderer: NativeRenderer) => void
) => void

export declare const runBench: RunBench
