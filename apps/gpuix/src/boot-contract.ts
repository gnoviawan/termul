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

import type { ClientConfig } from './client-config'
import type { ServerStatus } from './launcher/status'
import type { WindowSize } from './window'

export interface BootOptions {
  /** Whether the window takes keyboard focus on open. Headless runs pass `false`. */
  focus: boolean
  /** The launcher's view of the termul-server; the window shows its failures. */
  server: ServerStatus
  /** A second launch asked this window to come forward. */
  onFocusRequest(listener: () => void): void
  /** Initial window size. */
  window: WindowSize
  /** Termul's font faces (TTF bytes), registered before the first paint. */
  fonts: readonly Uint8Array[]
  /**
   * Reads the server's host-local credential at each handshake; `null` when
   * this app did not start the server (`launcher/host-local.ts`).
   */
  hostLocalToken: (() => string | null) | null
  /** Called once with the native renderer; perf runs wrap it to count round trips. */
  onRenderer?: (renderer: object) => void
  /** Receives the window's focus controls once the renderer exists (browser-pane keyboard pairing). */
  onFocusControl?(control: FocusControl): void
}

export interface FocusControl {
  /** The focused GPUIX element, `null` when none is. */
  focusedElement(): number | null
  /** Clear GPUIX focus. */
  blur(): void
  /**
   * This window's X11 id, from the patched addon's `getNativeWindowHandle`
   * (patch 0003). `null` on the published addon, on Wayland, and before the
   * window exists.
   */
  x11Window(): number | null
}

export type BootFn = (config: ClientConfig, options: BootOptions) => void

export declare const boot: BootFn
