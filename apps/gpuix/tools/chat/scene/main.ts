/**
 * `CHAT_SESSION=<id> | CHAT_START=<configId>|<projectId>|<cwd>` with
 * `CHAT_BOX=x,y,w,h CHAT_DEVICE=<id> bun dist/chat-scene/main.js`
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
import type { ControlIo, SceneCommand, SceneOptions, SceneTarget } from './contract'

function parseBox(raw: string | undefined): SceneOptions<unknown>['box'] {
  const [x, y, width, height] = (raw ?? '0,0,1280,800').split(',').map(Number)
  if (![x, y, width, height].every(Number.isFinite)) throw new Error(`CHAT_BOX is not x,y,w,h: ${raw}`)
  return { x, y, width, height }
}

function parseTarget(env: NodeJS.ProcessEnv): SceneTarget {
  if (env.CHAT_SESSION) return { kind: 'session', sessionId: env.CHAT_SESSION }
  const [configId, projectId, cwd] = (env.CHAT_START ?? '').split('|')
  if (configId && projectId && cwd) return { kind: 'start', configId, projectId, cwd }
  throw new Error('set CHAT_SESSION=<id> or CHAT_START=<configId>|<projectId>|<cwd>')
}

const target = parseTarget(process.env)
const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
if (process.env.CHAT_DEVICE) localStorage.setItem('termul.deviceId', process.env.CHAT_DEVICE)

// Non-literal: boot.tsx is app-side code, checked by tsconfig.chat.json, not this Bun-typed program.
const BOOT: string = './boot'
type RendererLike = { registerFont?(data: Buffer): void }
const { boot, setControlIo } = (await import(BOOT)) as {
  boot(config: ClientConfig, options: SceneOptions<RendererLike>): void
  setControlIo(io: ControlIo): void
}
setControlIo({
  read: (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SceneCommand
    } catch {
      return null
    }
  }
})
// fonts.ts resolves its directory from import.meta.dir, which is the dist dir once bundled.
const FONT_DIR = path.join(import.meta.dir, '../../assets/fonts')
boot(config, {
  target,
  box: parseBox(process.env.CHAT_BOX),
  control: process.env.CHAT_CONTROL,
  onRenderer: (renderer) => {
    for (const file of FONT_FILES) renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  }
})
