/**
 * Renders the showcase in Chromium and GPUIX for each theme and diffs them.
 *   bun tools/style/showcase/run.ts [outDir] [themeId...]
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestServer } from '../../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../../parity/shoot-gpuix'
import { printDiff } from './diff'
import { screenshotWeb } from './web'

const [outDir = '/tmp/gpuix-s1/showcase', ...requested] = process.argv.slice(2)
const themes = requested.length > 0 ? requested : ['termul', 'termul-light']
mkdirSync(outDir, { recursive: true })

/** The showcase never connects; withGpuix only forwards these as env. */
const NO_SERVER: TestServer = {
  baseUrl: 'http://127.0.0.1:9',
  token: '',
  stateDir: outDir,
  stop: async () => {}
}

for (const themeId of themes) {
  const web = join(outDir, `web-${themeId}.png`)
  const gpuix = join(outDir, `gpuix-${themeId}.png`)
  await screenshotWeb(web, themeId)
  process.env.SHOWCASE_THEME = themeId
  await withGpuix(
    {
      server: NO_SERVER,
      entry: join(import.meta.dir, 'gpuix-entry.tsx'),
      width: 1280,
      height: 800,
      clientStateDir: join(outDir, 'client-state')
    },
    async ({ app, grab }) => {
      await app.getByTestId('showcase-ready').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await grab(gpuix)
    }
  )
  console.log(`\n== ${themeId}\n  web   ${web}\n  gpuix ${gpuix}`)
  printDiff(web, gpuix, join(outDir, `diff-${themeId}.png`))
}
