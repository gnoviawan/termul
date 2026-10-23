/**
 * `CHAT_SESSION=<id> CHAT_BOX=x,y,w,h CHAT_DEVICE=<id> bun dist/chat-scene/main.js`
 * with the usual TERMUL_SERVER_URL / TERMUL_SERVER_TOKEN / TERMUL_GPUIX_STATE_DIR.
 * Installs the environment seam, pins the device id the seed registered the
 * agent under, registers Termul's fonts, and boots the transcript scene.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import type { ClientConfig } from '../../../src/client-config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { SceneCommand, SceneOptions } from './contract'

function parseBox(raw: string | undefined): SceneOptions<unknown>['box'] {
  const [x, y, width, height] = (raw ?? '0,0,1280,800').split(',').map(Number)
  if (![x, y, width, height].every(Number.isFinite)) throw new Error(`CHAT_BOX is not x,y,w,h: ${raw}`)
  return { x, y, width, height }
}

const sessionId = process.env.CHAT_SESSION
if (!sessionId) throw new Error('CHAT_SESSION is required')
const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
if (process.env.CHAT_DEVICE) localStorage.setItem('termul.deviceId', process.env.CHAT_DEVICE)

// Non-literal: boot.tsx is app-side code, checked by tsconfig.chat.json, not this Bun-typed program.
const BOOT: string = './boot'
type RendererLike = { registerFont?(data: Buffer): void }
const { boot, setControlReader } = (await import(BOOT)) as {
  boot(config: ClientConfig, options: SceneOptions<RendererLike>): void
  setControlReader(reader: (file: string) => SceneCommand | null): void
}
setControlReader((file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SceneCommand
  } catch {
    return null
  }
})
// fonts.ts resolves its directory from import.meta.dir, which is the dist dir once bundled.
const FONT_DIR = path.join(import.meta.dir, '../../assets/fonts')
boot(config, {
  sessionId,
  box: parseBox(process.env.CHAT_BOX),
  control: process.env.CHAT_CONTROL,
  onRenderer: (renderer) => {
    for (const file of FONT_FILES) renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  }
})
