/**
 * `COMPAT_FIXTURE=<name> bun dist-compat/main.js`: install the environment
 * seam, register Termul's fonts, boot one fixture. Writes the compat issue
 * report to `$COMPAT_REPORT` on exit.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compatReport } from '../../../src/compat/log'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import type { ClientConfig } from '../../../src/client-config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'

const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })

const report = process.env.COMPAT_REPORT
if (report) {
  const write = () => writeFileSync(report, JSON.stringify(compatReport(), null, 2))
  process.on('exit', write)
  process.on('SIGTERM', () => process.exit(0))
  setInterval(write, 1000).unref()
}

// Non-literal: boot.tsx is app-side code, checked by tsconfig.json, not this Bun-typed program.
const BOOT: string = './boot'
type RendererLike = { registerFont?(data: Buffer): void; getAutomationTree(): string }
const { boot } = (await import(BOOT)) as {
  boot(config: ClientConfig, fixture: string, onRenderer: (renderer: RendererLike) => void): void
}
// fonts.ts resolves its directory from import.meta.dir, which is dist-compat/ once bundled.
const FONT_DIR = path.join(import.meta.dir, '../assets/fonts')
const dump = process.env.COMPAT_DUMP
boot(config, process.env.COMPAT_FIXTURE ?? 'statusbar', (renderer) => {
  for (const file of FONT_FILES) renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  if (dump) setTimeout(() => writeFileSync(dump, renderer.getAutomationTree()), 6000)
})
