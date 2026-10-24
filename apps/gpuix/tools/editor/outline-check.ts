/**
 * `bun tools/editor/outline-check.ts [--out DIR]`
 *
 * The Preview outline on GPUIX: a long markdown file opens in Preview with
 * "On this page" beside it, a click on an outline row scrolls that heading
 * to the top of the preview, and the row turns active. Exits non-zero on a
 * failed assertion.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import {
  freePort,
  gpuixOpenFile,
  READY_TEXT,
  SIZE,
  STATE_ROOT,
  seedEditorProject
} from './scenario'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: path.join(STATE_ROOT, 'outline-check') } }
})
const OUT = values.out
const TARGET = 'Section 7'
const LONG_MD = [
  '# Long doc',
  '',
  ...Array.from({ length: 10 }, (_, s) =>
    [
      `## Section ${s + 1}`,
      '',
      ...Array.from({ length: 12 }, (_, p) => `Paragraph ${p + 1} of section ${s + 1}.\n`)
    ].join('\n')
  )
].join('\n')

let failed = false
function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed = true
}

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await mkdir(OUT, { recursive: true })
const stateDir = path.join(STATE_ROOT, 'outline-state')
const server = await startTestServer({
  port: await freePort(),
  token: 'outline-token',
  stateDir: path.join(stateDir, 'server')
})
try {
  const dir = await seedEditorProject(server)
  await writeFile(path.join(dir, 'long.md'), LONG_MD)
  await withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(stateDir, 'client'), ...SIZE },
    async ({ app, grab }) => {
      await app.getByText(READY_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await gpuixOpenFile(app, ['long.md'])
      await app.getByTestId('markdown-preview').waitFor({ timeoutMs: 15_000 })
      await app.getByText('On this page').waitFor({ timeoutMs: 15_000 })
      await Bun.sleep(800)
      await grab(path.join(OUT, 'preview.png'))
      const preview = await app.getByTestId('markdown-preview').bounds()
      const inOutline = async () =>
        (await app.getByText(TARGET).all()).find(
          (n) => (n.bounds?.x ?? 0) > preview.x + preview.width
        )?.bounds
      const inPreview = async () =>
        (await app.getByText(TARGET).all()).find(
          (n) => (n.bounds?.x ?? 0) < preview.x + preview.width
        )?.bounds
      const row = await inOutline()
      check(!!row, `"${TARGET}" is listed under On this page`)
      check(
        ((await inPreview())?.y ?? 0) - preview.y > preview.height,
        `"${TARGET}" starts below the fold`
      )
      if (row) await app.mouse.click({ x: row.x + 10, y: row.y + row.height / 2 })
      await Bun.sleep(3000)
      await grab(path.join(OUT, 'after-jump.png'))
      const top = ((await inPreview())?.y ?? Number.NaN) - preview.y
      check(
        top >= 0 && top <= 8,
        `an outline click scrolls "${TARGET}" to the preview top (${top} px)`
      )
      console.log(`    frames: ${OUT}`)
    }
  )
} catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.stop()
  await rm(stateDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
