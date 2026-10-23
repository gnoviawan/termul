/**
 * Regenerates src/terminal/fonts/PaperMono-{Regular,Bold}.ttf from the
 * app's variable PaperMono[wght].woff2: wawoff2 decompresses to a variable
 * TTF, then fontTools (through uvx) instances wght=400 and wght=700. GPUI on
 * Linux needs static faces; see src/terminal/fonts.ts.
 *
 * bun tools/terminal/fonts.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import wawoff2 from 'wawoff2'
import { TERMINAL_FONT_FILES } from '../../src/terminal/fonts'

const WOFF2 = resolve(
  import.meta.dir,
  '../../../../src/renderer/assets/fonts/paper-mono/PaperMono[wght].woff2'
)

async function instance(variable: string, weight: number, out: string): Promise<void> {
  const proc = Bun.spawn(
    [
      'uvx',
      '--from',
      'fonttools',
      'fonttools',
      'varLib.instancer',
      variable,
      `wght=${weight}`,
      '-o',
      out
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  )
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`fonttools instancer failed for wght=${weight}`)
}

const work = mkdtempSync(join(tmpdir(), 'paper-mono-'))
try {
  const variable = join(work, 'PaperMono.ttf')
  writeFileSync(
    variable,
    await wawoff2.decompress(new Uint8Array(await Bun.file(WOFF2).arrayBuffer()))
  )
  await instance(variable, 400, TERMINAL_FONT_FILES.regular)
  await instance(variable, 700, TERMINAL_FONT_FILES.bold)
  console.log(`wrote ${TERMINAL_FONT_FILES.regular} and ${TERMINAL_FONT_FILES.bold}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
