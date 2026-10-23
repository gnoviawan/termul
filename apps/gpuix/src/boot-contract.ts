/**
 * The boundary between the Bun side of the client (`main.tsx`, `env/`,
 * `launcher/`, the tools; typed with `@types/bun`) and the app side
 * (`boot.tsx`, `App.tsx` and everything under `src/renderer`; typed with the
 * DOM lib only, like the web build). The two cannot share one tsc program:
 * Bun's ambient types change what `setTimeout` and `import.meta.env` mean to
 * the shared files.
 *
 * `main.tsx` imports `#app/boot`. The bundler maps it to `boot.tsx` through
 * package.json `imports`; `tsconfig.tools.json` maps it here, so the Bun side
 * sees this contract and `boot.tsx` is checked against it by `tsconfig.json`.
 */

import type { DesktopHost } from '@/lib/desktop-host'
import type { ClientConfig } from './client-config'
import type { ServerStatus } from './launcher/status'

export interface BootOptions {
  /** Whether the window takes keyboard focus on open. Headless runs pass `false`. */
  focus: boolean
  /** The launcher's view of the termul-server; the window shows its failures. */
  server: ServerStatus
  /** A second launch asked this window to come forward. */
  onFocusRequest(listener: () => void): void
  /** OS openers and notifications for the shared facades. */
  desktopHost: DesktopHost
}

export type BootFn = (config: ClientConfig, options: BootOptions) => void

export declare const boot: BootFn
