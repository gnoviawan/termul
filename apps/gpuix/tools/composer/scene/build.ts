/**
 * Bundle the composer scene into `dist/composer-scene/`: `main.js`
 * (environment seam, Bun-typed) loads `boot.js` (the app side) at runtime, so
 * no `src/renderer` module evaluates before the globals exist.
 */

import path from 'node:path'
import { APP_DIR, buildClient } from '../../../build'

export const SCENE_OUT = path.join(APP_DIR, 'dist/composer-scene')

async function bundle(file: string): Promise<void> {
  const result = await buildClient(path.join(import.meta.dir, file), SCENE_OUT)
  for (const line of result.logs) console.error(line)
  if (!result.ok) throw new Error(`composer scene build failed: ${file}`)
}

export async function buildScene(): Promise<string> {
  await Promise.all([bundle('main.ts'), bundle('boot.tsx')])
  return path.join(SCENE_OUT, 'main.js')
}

if (import.meta.main) console.log(await buildScene())
