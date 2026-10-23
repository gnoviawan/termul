/**
 * `COMPOSER_START=<configId>|<projectId>|<cwd> COMPOSER_BOX=x,y,w COMPOSER_DEVICE=<id>
 *  [COMPOSER_SESSION_OUT=<file>] bun dist-composer/main.js`, with the usual
 * TERMUL_SERVER_URL / TERMUL_SERVER_TOKEN / TERMUL_GPUIX_STATE_DIR.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ComposerSceneBoot } from './contract'

const [configId, projectId, cwd] = (process.env.COMPOSER_START ?? '').split('|')
if (!configId || !projectId || !cwd)
  throw new Error('set COMPOSER_START=<configId>|<projectId>|<cwd>')
const [x, y, width] = (process.env.COMPOSER_BOX ?? '0,600,1280').split(',').map(Number)

const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
Object.assign(globalThis, { __TERMUL_GPUIX_TEST_HOOKS__: true })
if (process.env.COMPOSER_DEVICE)
  localStorage.setItem('termul.deviceId', process.env.COMPOSER_DEVICE)

// Non-literal: boot.tsx is app-side code, checked by tsconfig.composer.json, not this Bun-typed program.
const BOOT: string = './boot'
const { boot } = (await import(BOOT)) as { boot: ComposerSceneBoot }
const FONT_DIR = path.join(import.meta.dir, '../assets/fonts')
const sessionOut = process.env.COMPOSER_SESSION_OUT
boot(config, {
  start: { configId, projectId, cwd },
  box: { x, y, width },
  onSession: (id) => {
    if (sessionOut) writeFileSync(sessionOut, id)
  },
  onRenderer: (renderer) => {
    for (const file of FONT_FILES)
      renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  }
})
