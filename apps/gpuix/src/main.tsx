/**
 * Entry. Find or start the termul-server, install the browser environment
 * pointed at it, and only then load the modules that import `src/renderer`:
 * ESM hoists static imports, so the app tree is loaded with a dynamic import
 * after the globals exist. `#app/boot` is `boot.tsx` to the bundler and
 * `boot-contract.ts` to tsc.
 */

import { installBrowserEnv } from './env'
import { launch } from './launcher'
import { createDesktopHost } from './launcher/desktop-host'
import { log } from './log'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './window'

const launched = await launch()
if (launched.kind === 'secondary') process.exit(0)

const { config } = launched
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
log.info(
  'main',
  `server ${config.serverUrl.origin}, token ${config.token ? 'set' : 'none'}, state ${config.stateDir}`
)

const { boot } = await import('#app/boot')
// Headless runs (parity shots, agent checks) must not steal the keyboard.
boot(config, {
  focus: process.env.GPUIX_BACKGROUND !== '1',
  server: launched.status,
  onFocusRequest: launched.onFocusRequest,
  desktopHost: createDesktopHost()
})
