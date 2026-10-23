/**
 * Boot the shared renderer services the way `src/renderer/App.tsx` does for
 * the browser, then open the window. Implements `#app/boot` (see
 * `boot-contract.ts`).
 */

import { render } from '@gpuix/react'
import { getAcpTransport } from '@/lib/acp-transport'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { App } from './App'
import type { BootFn } from './boot-contract'
import { log } from './log'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './window'

export const boot: BootFn = (config, options) => {
  if (config.token) setWebAuthToken(config.token)
  ensureClientIdentity()
  checkWebAuthGate()
  // The browser root opens the `/ws` socket when its first event listener is
  // registered (`useAcpListeners`). Until those hooks are mounted here, open it
  // directly: the `projects` watch waits for the socket to be live.
  getAcpTransport()
    .connect()
    .catch((error: unknown) =>
      log.warn(
        'boot',
        `ws connect failed: ${error instanceof Error ? error.message : String(error)}`
      )
    )
  render(<App />, {
    title: 'Termul',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focus: options.focus
  })
}
