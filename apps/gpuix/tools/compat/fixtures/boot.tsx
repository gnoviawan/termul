/**
 * GPUIX side of a compat fixture: the shared target, unchanged, inside
 * `CompatRoot`, booted the way `src/boot.tsx` boots the client.
 */

import { render } from '@gpuix/react'
import { getAcpTransport } from '@/lib/acp-transport'
import { checkWebAuthGate } from '@/lib/web-auth-gate'
import { setWebAuthToken } from '@/lib/web-auth-token'
import { ensureClientIdentity } from '@/lib/web-client-identity'
import { CompatRoot, compatRenderOptions } from '../../../src/compat/root'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../../src/window'
import { FixtureRoot } from '#compat/fixture-dom'
import type { BootFixture } from './boot-contract'

export const boot: BootFixture = (config, fixture, onRenderer) => {
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
