/**
 * The boundary between the Bun side of the client (`main.tsx`, `env/`, the
 * tools; typed with `@types/bun`) and the app side (`boot.tsx`, `App.tsx` and
 * everything under `src/renderer`; typed with the DOM lib only, like the web
 * build). The two cannot share one tsc program: Bun's ambient types change
 * what `setTimeout` and `import.meta.env` mean to the shared files.
 *
 * `main.tsx` imports `#app/boot`. The bundler maps it to `boot.tsx` through
 * package.json `imports`; `tsconfig.tools.json` maps it here, so the Bun side
 * sees this contract and `boot.tsx` is checked against it by `tsconfig.json`.
 */

import type { ClientConfig } from './client-config'

export interface BootOptions {
  /** Whether the window takes keyboard focus on open. Headless runs pass `false`. */
  focus: boolean
}

export type BootFn = (config: ClientConfig, options: BootOptions) => void

export declare const boot: BootFn
