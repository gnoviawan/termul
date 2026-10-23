/**
 * Entry. Parse the config, install the browser environment, and only then load
 * the modules that import `src/renderer`: ESM hoists static imports, so the
 * app tree is loaded with a dynamic import after the globals exist.
 * `#app/boot` is `boot.tsx` to the bundler and `boot-contract.ts` to tsc.
 */

import { installBrowserEnv } from './env'
import { readClientConfig } from './env/config'
import { log } from './log'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './window'

const config = readClientConfig()
installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
log.info(
  'main',
  `server ${config.serverUrl.origin}, token ${config.token ? 'set' : 'none'}, state ${config.stateDir}`
)

const { boot } = await import('#app/boot')
// Headless runs (parity shots, agent checks) must not steal the keyboard.
boot(config, { focus: process.env.GPUIX_BACKGROUND !== '1' })
