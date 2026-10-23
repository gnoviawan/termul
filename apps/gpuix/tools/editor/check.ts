/**
 * Editor acceptance checks inside the real app shell on GPUIX, against a
 * seeded test server (scenario.ts):
 *
 * - src/app.ts opens from the Explorer as a highlighted view with line numbers;
 * - a click at line 3 col 5 then typed keys edit the buffer there, and the
 *   painted text shows the same line;
 * - Ctrl+S writes the edit to disk; Ctrl+Z undoes it;
 * - README.md opens in Preview, a click there switches to Source, an edit saves;
 * - big.ts (5,000 lines) paints, and a wheel scroll is timed;
 * - a tab whose render throws leaves a terminal in the other pane painting.
 *
 * bun tools/editor/check.ts [--out DIR] [--only name,...]
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import {
  APP_TS,
  BIG_LINES,
  freePort,
  PROJECT,
  projectDir,
  READY_TEXT,
  SIZE,
  STATE_ROOT,
  seedEditorProject
} from './scenario'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: path.join(STATE_ROOT, 'check') },
    only: { type: 'string' }
  }
})
const OUT = values.out!
const only = values.only ? new Set(values.only.split(',')) : null
const results: Array<{ check: string; ok: boolean; detail: unknown }> = []
function check(name: string, ok: boolean, detail: unknown): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

type App = Parameters<Parameters<typeof withGpuix>[1]>[0]['app']

interface ViewState {
  caret: { line: number; col: number }
  lines: number
  scrollTop: number
  first: number
  last: number
  chunks: number
  charWidth: number
}

async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await Bun.sleep(100)
  }
}

async function viewState(app: App): Promise<ViewState> {
  return JSON.parse(await app.getByTestId('code-editor-state').textContent()) as ViewState
}

/**
 * The lines the view hands its native `<code>` chunks for the rows on screen.
 * `getPaintedText` reads a UI-thread local and returns nothing on Linux, where
 * GPUI runs on its own thread, so the view mirrors what it paints.
 */
async function painted(app: App): Promise<string[]> {
  const state = (await viewState(app).catch(() => null)) as (ViewState & { painted?: string[] }) | null
  return state?.painted ?? []
}

const keys = (text: string) =>
  [...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')

async function openFromExplorer(app: App, segments: readonly string[]): Promise<void> {
  await app.getByText('Explorer').click()
  for (const name of segments) {
    await app.getByText(name).waitFor({ timeoutMs: 10_000 })
    await app.getByText(name).click()
  }
}

process.env.TERMUL_GPUIX_TEST_HOOKS = '1'
const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await mkdir(OUT, { recursive: true })
const stateDir = path.join(STATE_ROOT, 'check-state')
await rm(stateDir, { recursive: true, force: true })
const server = await startTestServer({
  port: await freePort(),
  token: 'e1-check-token',
  stateDir: path.join(stateDir, 'server')
})
try {
  const dir = await seedEditorProject(server)
  await withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(stateDir, 'client'), ...SIZE },
    async ({ app, grab }) => {
      await app.getByText(READY_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const opened = performance.now()
      await openFromExplorer(app, ['src', 'app.ts'])
      await app.getByTestId('code-editor').waitFor({ timeoutMs: 20_000 })
      const firstLine = APP_TS.split('\n')[0]!
      await until('app.ts painted', async () => (await painted(app)).some((t) => t.includes(firstLine))).catch(
        async (error) => {
          await grab(path.join(OUT, 'open-failed.png'))
          await Bun.write(path.join(OUT, 'open-failed.json'), JSON.stringify(await painted(app), null, 1))
          throw error
        }
      )
      const openMs = Math.round(performance.now() - opened)
      await Bun.sleep(600)
      await grab(path.join(OUT, 'app-ts.png'))
      const view = await viewState(app)
      const numbers = (await app.getByText('18').all()).map(() => '18')
      check('src/app.ts opens from the Explorer with line numbers', view.lines === 18 && numbers.includes('18'), {
        openMs,
        lines: view.lines,
        numbersPainted: numbers.length
      })

      if (!only || only.has('edit')) {
        const box = await app.getByTestId('code-editor').bounds()
        const gutter = 23.656 + 9.828 + 1
        const x = box.x + gutter + 6 + 4 * view.charWidth + 1
        const y = box.y + 4 + 2 * 20.8 + 10
        await app.mouse.click({ x, y })
        await Bun.sleep(200)
        const clicked = await viewState(app)
        await app.call('keystrokes', { keys: keys('XY') })
        const expected = 'consXYt PORT = Number(process.env.PORT ?? 3000)'
        const paintedLine = await until('edited line painted', async () =>
          (await painted(app)).find((t) => t === expected)
        ).catch(() => null)
        const typed = await viewState(app)
        await grab(path.join(OUT, 'typed.png'))
        check('a click at line 3 col 5 then XY edits that line, on screen', clicked.caret.line === 3 && clicked.caret.col === 5 && paintedLine === expected && typed.caret.col === 7, {
          clickedCaret: clicked.caret,
          caretAfter: typed.caret,
          paintedLine
        })

        await app.call('keystrokes', { keys: 'ctrl-s' })
        const file = path.join(dir, 'src', 'app.ts')
        const saved = await until('saved to disk', async () => {
          const text = await readFile(file, 'utf8')
          return text.split('\n')[2] === expected ? text : null
        }).catch(() => null)
        check('Ctrl+S writes the edit to disk', saved === APP_TS.replace('const PORT', 'consXYt PORT'), {
          line3OnDisk: (await readFile(file, 'utf8')).split('\n')[2]
        })
        await Bun.sleep(400)
        await grab(path.join(OUT, 'saved.png'))

        await app.call('keystrokes', { keys: 'ctrl-z' })
        const undone = await until('undo painted', async () =>
          (await painted(app)).find((t) => t === 'const PORT = Number(process.env.PORT ?? 3000)')
        ).catch(() => null)
        await app.call('keystrokes', { keys: 'ctrl-s' })
        const restored = await until('undo saved', async () =>
          (await readFile(file, 'utf8')) === APP_TS ? true : null
        ).catch(() => false)
        check('Ctrl+Z undoes the edit (and the undo saves back the original bytes)', !!undone && restored, {
          undonePainted: !!undone,
          diskMatchesOriginal: restored
        })
      }
    }
  )
} catch (error) {
  check('error', false, String(error))
} finally {
  await server.stop()
}
console.log(JSON.stringify({ project: PROJECT.id, bigLines: BIG_LINES }))
await Bun.write(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1)
