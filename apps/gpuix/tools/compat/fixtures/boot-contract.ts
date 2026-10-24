/**
 * The boundary between the Bun-typed fixture entry (`main.ts`) and the
 * app-typed boot (`boot.tsx`), the same split as `src/boot-contract.ts`:
 * `#compat/fixture-boot` is `boot.tsx` to the bundler and this file to tsc.
 */

import type { NativeRenderer } from '@gpuix/react'
import type { ClientConfig } from '../../../src/client-config'

export type BootFixture = (
  config: ClientConfig,
  fixture: string,
  onRenderer: (renderer: NativeRenderer) => void
) => void

export declare const boot: BootFixture
