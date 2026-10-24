/**
 * Web vs GPUIX shot of src/app.ts opened from the Explorer, both in the real
 * shell at 1280x800, each against a fresh test server seeded the same way.
 * Focus is dropped before the grab in both clients so neither paints a
 * blinking caret. The editor box the web client paints (`.cm-editor`) is
 * cropped from both frames and diffed (exact and perceptual), as is the
 * whole window.
 *
 * The web client is this worktree's dist-web (`bun run build:web` at the repo root).
 *
 * bun tools/editor/parity.ts [--out DIR]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { cropPng, diffPngs, type Rect } from '../parity/diff'
import { startTestServer, type TestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { withWeb } from '../parity/shoot-web'
import {
  freePort,
  gpuixOpenFile,
  READY_TEXT,
  SIZE,
  STATE_ROOT,
  seedEditorProject,
  webOpenFile
} from './scenario'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: path.join(STATE_ROOT, 'parity') } }
})
const OUT = values.out!
const STATE = path.join(STATE_ROOT, 'parity-state')
await mkdir(OUT, { recursive: true })

async function withSeeded<T>(body: (server: TestServer) => Promise<T>): Promise<T> {
  const server = await startTestServer({
    port: await freePort(),
    token: 'e1-parity-token',
    stateDir: path.join(STATE, 'server')
  })
  try {
    await seedEditorProject(server)
    return await body(server)
  } finally {
    await server.stop()
  }
}

const webPng = path.join(OUT, 'web-window.png')
const gpuixPng = path.join(OUT, 'gpuix-window.png')

const editorBox = await withSeeded((server) =>
  withWeb({ server, ...SIZE }, async ({ page, grab }) => {
    await webOpenFile(page, ['src', 'app.ts'])
    await page.locator('.cm-content').first().waitFor({ timeout: 30_000 })
    await page.mouse.move(900, 600)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.waitForTimeout(800)
    await grab(webPng)
    const box = await page.locator('.cm-editor').first().boundingBox()
    if (!box) throw new Error('web: no .cm-editor box')
    return box
  })
)

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await withSeeded((server) =>
  withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(STATE, 'client'), ...SIZE },
    async ({ app, grab }) => {
      await app.getByText(READY_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      await gpuixOpenFile(app, ['src', 'app.ts'])
      await app.getByTestId('code-editor-app.ts').waitFor({ timeoutMs: 20_000 })
      await app.mouse.move({ x: 900, y: 600 })
      await Bun.sleep(1500)
      await app.call('blur', {})
      await Bun.sleep(800)
      await grab(gpuixPng)
    }
  )
)

const roi: Rect = {
  x: Math.round(editorBox.x),
  y: Math.round(editorBox.y),
  width: Math.round(editorBox.width),
  height: Math.round(editorBox.height)
}
const results: Record<string, unknown> = { roi }
for (const [name, rect] of [
  ['editor', roi],
  ['window', { x: 0, y: 0, ...SIZE }]
] as const) {
  const web = path.join(OUT, `web-${name}.png`)
  const gpuix = path.join(OUT, `gpuix-${name}.png`)
  cropPng(webPng, rect, web)
  cropPng(gpuixPng, rect, gpuix)
  results[name] = diffPngs(web, gpuix, path.join(OUT, `diff-${name}.png`))
}
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
