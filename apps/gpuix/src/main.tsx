/**
 * Entry. Find or start the termul-server, install the browser environment
 * pointed at it, and only then load the modules that import `src/renderer`:
 * ESM hoists static imports, so the app tree is loaded with a dynamic import
 * after the globals exist. `#app/boot` is `boot.tsx` to the bundler and
 * `boot-contract.ts` to tsc.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDesktopHost } from '@/lib/desktop-host'
import type { FocusControl } from './boot-contract'
import { detectBrowserSupport } from './browser/support'
import { installBrowserEnv } from './env'
import { readInitialWindowSize } from './env/window-size'
import { launch } from './launcher'
import { createDesktopHost } from './launcher/desktop-host'
import { readHostLocalToken } from './launcher/host-local'
import { log } from './log'
import { captureZoomRoots } from './shims/window-zoom'
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

// Before the app tree loads: the keyboard-shortcuts store reads its desktop
// defaults from the registered host when its module is evaluated.
registerDesktopHost(createDesktopHost())
let focusControl: FocusControl | null = null
const browserSupport = detectBrowserSupport(process.env, process.platform, import.meta.dir)
if (browserSupport.kind === 'x11') {
  const [{ registerBrowserHost }, { createGpuixBrowserHost }] = await Promise.all([
    import('@/lib/browser-host'),
    import('./browser/browser-host')
  ])
  const browserHost = createGpuixBrowserHost({
    binary: browserSupport.binary,
    parentPid: process.pid,
    focusedElement: () => focusControl?.focusedElement() ?? null,
    blurApp: () => focusControl?.blur()
  })
  registerBrowserHost(browserHost)
  process.on('exit', () => browserHost.kill())
  log.info('browser', `browser panes on, helper ${browserSupport.binary}`)
} else {
  log.info('browser', `browser panes off: ${browserSupport.reason}`)
}
// The window zoom needs the React root. The reconciler instance is not in
// @gpuix/react's exports, so it is imported by file: the same module record
// @gpuix/react loaded, because the loader keys modules by resolved path.
const reconcilerFile = path.join(
  path.dirname(Bun.resolveSync('@gpuix/react', import.meta.dir)),
  'reconciler/reconciler.js'
)
captureZoomRoots((await import(pathToFileURL(reconcilerFile).href)).reconciler)
const { boot } = await import('#app/boot')
// Headless runs (parity shots, agent checks) must not steal the keyboard.
boot(config, {
  focus: process.env.GPUIX_BACKGROUND !== '1',
  server: launched.status,
  onFocusRequest: launched.onFocusRequest,
  window: windowSize,
  fonts,
  hostLocalToken: hostLocalTokenFile ? () => readHostLocalToken(hostLocalTokenFile) : null,
  onFocusControl: (control) => {
    focusControl = control
  }
})
