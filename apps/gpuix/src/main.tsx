/**
 * Entry. Find or start the termul-server, install the browser environment
 * pointed at it, and only then load the modules that import `src/renderer`:
 * ESM hoists static imports, so the app tree is loaded with a dynamic import
 * after the globals exist. `#app/boot` is `boot.tsx` to the bundler and
 * `boot-contract.ts` to tsc.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { installBrowserEnv } from './env'
import { readInitialWindowSize } from './env/window-size'
import { launch } from './launcher'
import { createDesktopHost } from './launcher/desktop-host'
import { readHostLocalToken } from './launcher/host-local'
import { log } from './log'
import { FONT_FILES } from './style/fonts'

const launched = await launch()
if (launched.kind === 'secondary') process.exit(0)

const { config } = launched
const { hostLocalTokenFile } = config
const windowSize = readInitialWindowSize()
installBrowserEnv(config, windowSize)
log.info(
  'main',
  `server ${config.serverUrl.origin}, token ${config.token ? 'set' : 'none'}, state ${config.stateDir}`
)

// fonts.ts resolves its directory from import.meta.dir, which is dist/ once bundled.
const FONT_DIR = path.join(import.meta.dir, '../assets/fonts')
const fonts = FONT_FILES.map((file) => readFileSync(path.join(FONT_DIR, path.basename(file))))

const { boot } = await import('#app/boot')
// Headless runs (parity shots, agent checks) must not steal the keyboard.
boot(config, {
  focus: process.env.GPUIX_BACKGROUND !== '1',
  server: launched.status,
  onFocusRequest: launched.onFocusRequest,
  desktopHost: createDesktopHost(),
  window: windowSize,
  fonts,
  hostLocalToken: hostLocalTokenFile ? () => readHostLocalToken(hostLocalTokenFile) : null
})
