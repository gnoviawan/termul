/** Bundle the GPUIX side of the compat fixtures into `dist-compat/`. */

import path from 'node:path'
import { APP_DIR, buildClient } from '../../build'

export const FIXTURE_ENTRY = path.join(APP_DIR, 'tools/compat/fixtures/main.ts')
export const FIXTURE_OUT = path.join(APP_DIR, 'dist-compat')

export async function buildFixtures(): Promise<string> {
  const result = await buildClient(FIXTURE_ENTRY, FIXTURE_OUT)
  for (const line of result.logs) console.error(line)
  if (!result.ok) throw new Error('compat fixture build failed')
  return result.entry
}

if (import.meta.main) {
  const started = performance.now()
  const entry = await buildFixtures()
  console.log(`built ${path.relative(APP_DIR, entry)} in ${Math.round(performance.now() - started)} ms`)
}
