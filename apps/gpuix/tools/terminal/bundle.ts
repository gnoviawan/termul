/**
 * Bundles the terminal tool entries with the client's resolver (`build.ts`),
 * so `src/renderer` imports resolve the way they do in the app: one React,
 * `@/` and `@shared/` aliases, `@tauri-apps/*` stubs. The font files are
 * copied next to the bundles by Bun's file loader.
 */

import path from 'node:path'
import { APP_DIR, EXTERNAL, termulResolver } from '../../build'

const TERMINAL_ENTRIES = {
  demo: 'demo.tsx',
  'parity-gpuix': 'parity-gpuix.tsx',
  'throughput-gpuix': 'throughput-gpuix.tsx',
  record: 'record.ts'
} as const
export type TerminalEntry = keyof typeof TERMINAL_ENTRIES

const OUT_DIR = path.join(APP_DIR, 'dist/terminal')

let built: Promise<void> | null = null

function buildOnce(): Promise<void> {
  built ??= (async () => {
    const result = await Bun.build({
      entrypoints: Object.values(TERMINAL_ENTRIES).map((file) => path.join(import.meta.dir, file)),
      outdir: OUT_DIR,
      target: 'bun',
      format: 'esm',
      sourcemap: 'linked',
      external: EXTERNAL.flatMap((name) => [name, `${name}/*`]),
      plugins: [termulResolver()],
      naming: { entry: '[name].[ext]', asset: '[name]-[hash].[ext]' }
    })
    for (const line of result.logs) console.error(String(line))
    if (!result.success) throw new Error('terminal tool bundle failed')
  })()
  return built
}

/** Absolute path of the bundled entry, built on first use in this process. */
export async function terminalEntry(name: TerminalEntry): Promise<string> {
  await buildOnce()
  return path.join(OUT_DIR, `${name}.js`)
}
