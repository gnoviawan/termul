/**
 * Bundle the composer scene into `dist-composer/`: `main.js` (environment
 * seam, Bun-typed) loads `boot.js` (the app side) at runtime, so no
 * `src/renderer` module evaluates before the globals exist.
 */

import path from 'node:path'
import { APP_DIR, compatPlugin, overridesPlugin, termulResolver } from '../../../build'
import { gpuixUiAliases } from '../../ui/alias'
import { globPlugin, rawPlugin } from './vite-plugins'

export const SCENE_OUT = path.join(APP_DIR, 'dist-composer')

export async function buildScene(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'main.ts'), path.join(import.meta.dir, 'boot.tsx')],
    outdir: SCENE_OUT,
    target: 'bun',
    format: 'esm',
    sourcemap: 'linked',
    external: ['@gpuix/react', '@gpuix/react/*', '@gpuix/native', '@gpuix/native/*'],
    plugins: [rawPlugin(), globPlugin(), compatPlugin(), gpuixUiAliases(), overridesPlugin(), termulResolver()],
    naming: '[name].[ext]'
  })
  for (const line of result.logs) console.error(String(line))
  if (!result.success) throw new Error('composer scene build failed')
  return path.join(SCENE_OUT, 'main.js')
}

if (import.meta.main) console.log(await buildScene())
