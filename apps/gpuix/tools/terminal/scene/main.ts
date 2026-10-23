/**
 * `PANE_CONTROL=<cmd.json> PANE_STATE=<state.json> bun dist/terminal-scene/main.js`
 * with TERMUL_SERVER_URL / TERMUL_SERVER_TOKEN / TERMUL_GPUIX_STATE_DIR.
 * Installs the environment seam, registers Termul's fonts, and boots the
 * workspace terminal pane scene.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ClientConfig } from '../../../src/client-config'
import { installBrowserEnv } from '../../../src/env'
import { readClientConfig } from '../../../src/env/config'
import { FONT_FILES } from '../../../src/style/fonts'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ControlIo, PaneCommand, PaneSceneOptions } from './contract'

const control = process.env.PANE_CONTROL
const stateFile = process.env.PANE_STATE
if (!control || !stateFile) throw new Error('set PANE_CONTROL and PANE_STATE')
const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })

// Non-literal: boot.tsx is app-side code, typed by tsconfig.terminal.json's JSX settings.
const BOOT: string = './boot'
type RendererLike = { registerFont?(data: Buffer): void }
const { boot, setControlIo } = (await import(BOOT)) as {
  boot(config: ClientConfig, options: PaneSceneOptions<RendererLike>): void
  setControlIo(io: ControlIo): void
}
setControlIo({
  read: (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as PaneCommand
    } catch {
      return null
    }
  },
  write: (file, text) => {
    writeFileSync(`${file}.tmp`, text)
    renameSync(`${file}.tmp`, file)
  }
})
const FONT_DIR = path.join(import.meta.dir, '../../assets/fonts')
const box = process.env.PANE_BOX?.split(',').map(Number)
boot(config, {
  control,
  stateFile,
  box:
    box && box.length === 4 && box.every(Number.isFinite)
      ? { x: box[0]!, y: box[1]!, width: box[2]!, height: box[3]! }
      : undefined,
  onRenderer: (renderer) => {
    for (const file of FONT_FILES)
      renderer.registerFont?.(readFileSync(path.join(FONT_DIR, path.basename(file))))
  }
})
