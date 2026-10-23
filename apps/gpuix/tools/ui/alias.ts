/**
 * Bundler alias that swaps Termul's ui primitives and icons for their GPUIX
 * twins: `@/components/ui/<name>` -> `apps/gpuix/src/ui/<name>` and
 * `@/components/icons` -> `apps/gpuix/src/icons`, for every importer. A name
 * with no GPUIX twin falls through to the next resolver (the web file).
 * Register it before `termulResolver()`.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'

const SRC = path.resolve(import.meta.dir, '../../src')

export function gpuixTwin(specifier: string): string | undefined {
  const match = specifier.match(/^@\/components\/(ui\/[\w-]+|icons)$/)
  if (!match) return undefined
  const base = match[1] === 'icons' ? path.join(SRC, 'icons/index') : path.join(SRC, match[1])
  return ['.tsx', '.ts'].map((ext) => base + ext).find((file) => existsSync(file))
}

export function gpuixUiAliases(): BunPlugin {
  return {
    name: 'termul-gpuix-ui-aliases',
    setup(build) {
      build.onResolve({ filter: /^@\/components\/(ui\/[\w-]+|icons)$/ }, (args) => {
        const twin = gpuixTwin(args.path)
        return twin ? { path: twin } : undefined
      })
    }
  }
}
