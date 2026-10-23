/**
 * Renders the showcase in Chromium and GPUIX for each theme and diffs them.
 *   bun tools/style/showcase/run.ts [outDir] [themeId...]
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { diffImages } from './diff'
import { screenshotWeb } from './web'

const [outDir = '/tmp/gpuix-s1/showcase', ...requested] = process.argv.slice(2)
const themes = requested.length > 0 ? requested : ['termul', 'termul-light']
mkdirSync(outDir, { recursive: true })

for (const themeId of themes) {
  const web = join(outDir, `web-${themeId}.png`)
  const gpuix = join(outDir, `gpuix-${themeId}.png`)
  await screenshotWeb(web, themeId)
  const shot = spawnSync(
    join(import.meta.dir, 'xshot.sh'),
    [join(import.meta.dir, 'gpuix-entry.tsx'), gpuix, 'showcase ready', '90'],
    { env: { ...process.env, SHOWCASE_THEME: themeId }, encoding: 'utf8' }
  )
  if (shot.status !== 0) throw new Error(`GPUIX capture failed for ${themeId}: ${shot.stderr}`)
  console.log(`\n== ${themeId}\n  web   ${web}\n  gpuix ${gpuix}`)
  for (const tolerance of [0, 8, 16]) {
    const result = diffImages(
      web,
      gpuix,
      join(outDir, `diff-${themeId}-t${tolerance}.png`),
      tolerance
    )
    console.log(
      `  tolerance ${String(tolerance).padStart(2)}: ${result.percent.toFixed(2)}% of pixels differ`
    )
    if (tolerance === 8) {
      for (const cell of result.cells)
        console.log(`    ${cell.id.padEnd(20)} ${cell.percent.toFixed(2).padStart(6)}%`)
    }
  }
}
