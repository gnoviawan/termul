/**
 * GPUIX side of a compat fixture: the shared target, unchanged, inside
 * `CompatRoot`, booted the way `src/boot.tsx` boots the client.
 */

import { type NativeRenderer, render } from '@gpuix/react'
import { getAcpTransport } from '@/lib/acp-transport'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import type { ClientConfig } from '../../../src/client-config'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import type { ComponentType } from 'react'

// A non-literal specifier keeps the DOM-typed fixtures out of this program;
// tsconfig.compat.json checks them under React DOM's JSX types.
const DOM_FIXTURES: string = './dom'
const { FixtureRoot } = (await import(DOM_FIXTURES)) as { FixtureRoot: ComponentType<{ name: string }> }

export function boot(
  config: ClientConfig,
  fixture: string,
  onRenderer: (renderer: NativeRenderer) => void
): void {
  if (config.token) setWebAuthToken(config.token)
  ensureClientIdentity()
  checkWebAuthGate()
  getAcpTransport()
    .connect()
    .catch(() => {})
  render(
    <CompatRoot onRenderer={onRenderer}>
      <FixtureRoot name={fixture} />
    </CompatRoot>,
    {
      title: `Termul compat: ${fixture}`,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focus: false,
      ...compatRenderOptions
    }
  )
}
