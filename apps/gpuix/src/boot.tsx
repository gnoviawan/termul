/**
 * Open the window and mount Termul's browser root in it once the server is
 * ready. Implements `#app/boot` (see `boot-contract.ts`). Everything the web
 * root starts (client identity, the auth gate, the `/ws` socket) starts from
 * its own hooks; this file adds only what `src/renderer/main.tsx` does before
 * it renders, and the window itself.
 */

import { type NativeRenderer, render } from '@gpuix/react'
import { registerDesktopHost } from '@/lib/desktop-host'
import { installGlobalErrorForwarding } from '@/lib/log-api'
import { setHostLocalTokenSource, setWebAuthToken } from '@/lib/web-auth-token'
import { App } from './App'
import type { BootFn } from './boot-contract'
import { compatRenderOptions } from './compat/root'
import { ServerGate } from './launcher/ServerGate'
import { log } from './log'
import { DESKTOP_WINDOW } from './window'

export const boot: BootFn = (config, options) => {
  if (config.token) setWebAuthToken(config.token)
  setHostLocalTokenSource(options.hostLocalToken)
  registerDesktopHost(options.desktopHost)
  const registerFonts = (renderer: NativeRenderer) => {
    for (const font of options.fonts)
      renderer.registerFont?.(font as Parameters<NonNullable<NativeRenderer['registerFont']>>[0])
    log.info('boot', `registered ${options.fonts.length} font faces`)
  }
  render(
    <ServerGate
      status={options.server}
      onFocusRequest={options.onFocusRequest}
      onFirstReady={installGlobalErrorForwarding}
    >
      <App onRenderer={registerFonts} />
    </ServerGate>,
    {
      title: DESKTOP_WINDOW.title,
      width: options.window.width,
      height: options.window.height,
      minWidth: DESKTOP_WINDOW.minWidth,
      minHeight: DESKTOP_WINDOW.minHeight,
      focus: options.focus,
      ...compatRenderOptions
    }
  )
}
