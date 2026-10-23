/**
 * The window's content: Termul's browser root rendered through the compat
 * runtime. Providers, the headless hooks and the routes are the web root's
 * own (`src/renderer/App.tsx`); the env seam gives its hash router a session
 * history, so the routes stay identical.
 */

import type { NativeRenderer } from '@gpuix/react'
import { WebApp } from '#app/web-root'
import { CompatRoot } from './compat/root'

export interface AppProps {
  /** Runs once with the renderer before the shared tree mounts (font registration). */
  onRenderer(renderer: NativeRenderer): void
}

export function App({ onRenderer }: AppProps) {
  return (
    <CompatRoot onRenderer={onRenderer}>
      <WebApp />
    </CompatRoot>
  )
}
