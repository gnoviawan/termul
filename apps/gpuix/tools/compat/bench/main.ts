/** `BENCH_MODE=compat|hand BENCH_OUT=x.json bun dist-bench/main.js` */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'

installBrowserEnv(readClientConfig(), { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
const FONT_DIR = path.join(import.meta.dir, '../assets/fonts')
// Non-literal: app.tsx is app-side code, checked by tsconfig.json, not this Bun-typed program.
const APP: string = './app'
interface BenchHost {
  sleep(ms: number): Promise<void>
  gc(): void
  rssBytes(): number
  write(json: string): void
  exit(): void
}
const { runBench } = (await import(APP)) as {
  runBench(mode: 'compat' | 'hand', host: BenchHost, onRenderer: (renderer: { registerFont?(data: Buffer): void }) => void): void
}
const out = process.env.BENCH_OUT ?? '/tmp/gpuix-c1/bench.json'
runBench(
  process.env.BENCH_MODE === 'hand' ? 'hand' : 'compat',
  {
    sleep: (ms) => Bun.sleep(ms),
    gc: () => Bun.gc(true),
    rssBytes: () => process.memoryUsage().rss,
    write: (json) => writeFileSync(out, json),
    exit: () => process.exit(0)
  },
  (renderer) => {
    for (const file of FONT_FILES) renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  }
)
