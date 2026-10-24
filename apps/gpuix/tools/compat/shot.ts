/**
 * `bun tools/compat/shot.ts <entry> <out.png> [--wait testId] [--env K=V]...`
 *
 * Runs one GPUIX entry under Xvfb + lavapipe, waits for a test id, and grabs
 * the frame. For probes and fixtures that need no termul-server.
 */

import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { grabFrame, LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb, windowOrigin } from '../parity/shoot-gpuix'

export interface ShotOptions {
  entry: string
  out: string
  waitTestId?: string
  env?: Record<string, string>
  settleMs?: number
}

export async function shoot(opts: ShotOptions): Promise<void> {
  const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
  try {
    const app = await launch({
      command: 'bun',
      args: [opts.entry],
      cwd: path.dirname(opts.entry),
      env: {
        ...process.env,
        ...opts.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1'
      }
    })
    try {
      if (opts.waitTestId) await app.getByTestId(opts.waitTestId).waitFor({ timeoutMs: 60_000 })
      await Bun.sleep(opts.settleMs ?? 600)
      await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, opts.out, await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT))
    } finally {
      await app.close()
    }
  } finally {
    xvfb.stop()
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: { wait: { type: 'string' }, env: { type: 'string', multiple: true } }
  })
  const [entry, out] = positionals
  if (!entry || !out) {
    console.error('usage: bun tools/compat/shot.ts <entry> <out.png> [--wait testId] [--env K=V]')
    process.exit(2)
  }
  const env = Object.fromEntries((values.env ?? []).map((kv) => kv.split(/=(.*)/s).slice(0, 2)))
  await shoot({ entry: path.resolve(entry), out: path.resolve(out), waitTestId: values.wait, env })
  console.log(`wrote ${out}`)
}
