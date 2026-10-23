/** `BENCH_MODE=compat|hand BENCH_OUT=x.json bun dist-bench/main.js` */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'

installBrowserEnv(readClientConfig(), { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
const FONT_DIR = path.join(import.meta.dir, '../assets/fonts')
const { runBench } = await import('#compat/bench-app')
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
