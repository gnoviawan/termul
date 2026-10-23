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
import { cropPng, diffPngs } from '../parity/diff'
import { startTestServer } from '../parity/server'
import { READY_TIMEOUT_MS, withGpuix } from '../parity/shoot-gpuix'
import { openStatusBarTerminal, rowMatching, terminals } from '../terminal/shell-tree'
import {
  APP_TS,
  BIG_LINES,
  freePort,
  gpuixOpenFile as openFromExplorer,
  PROJECT,
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

async function until<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  ms = 15_000
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await Bun.sleep(100)
  }
}

let editorId = 'code-editor-app.ts'
async function viewState(app: App): Promise<ViewState> {
  return JSON.parse(await app.getByTestId(`${editorId}-state`).textContent()) as ViewState
}

/**
 * The lines the view hands its native `<code>` chunks for the rows on screen.
 * `getPaintedText` reads a UI-thread local and returns nothing on Linux, where
 * GPUI runs on its own thread, so the view mirrors what it paints.
 */
async function painted(app: App): Promise<string[]> {
  const state = (await viewState(app).catch(() => null)) as
    | (ViewState & { painted?: string[] })
    | null
  return state?.painted ?? []
}

const keys = (text: string) => [...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')

process.env.TERMUL_GPUIX_TEST_HOOKS = '1'
process.env.TERMUL_GPUIX_EDITOR_PERF = '1'
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
      await app.getByTestId(editorId).waitFor({ timeoutMs: 20_000 })
      const firstLine = APP_TS.split('\n')[0]!
      await until('app.ts painted', async () =>
        (await painted(app)).some((t) => t.includes(firstLine))
      ).catch(async (error) => {
        await grab(path.join(OUT, 'open-failed.png'))
        await Bun.write(
          path.join(OUT, 'open-failed.json'),
          JSON.stringify(await painted(app), null, 1)
        )
        throw error
      })
      const openMs = Math.round(performance.now() - opened)
      await Bun.sleep(600)
      await grab(path.join(OUT, 'app-ts.png'))
      const view = await viewState(app)
      const numbers = (await app.getByText('18').all()).map(() => '18')
      check(
        'src/app.ts opens from the Explorer with line numbers',
        view.lines === 18 && numbers.includes('18'),
        {
          openMs,
          lines: view.lines,
          numbersPainted: numbers.length
        }
      )

      if (!only || only.has('edit')) {
        const box = await app.getByTestId(editorId).bounds()
        const gutter = 23.656 + 9.828 + 1
        const x = box.x + gutter + 6 + 4 * view.charWidth + 1
        const y = box.y + 4 + 2 * 20.8 + 10
        await app.mouse.click({ x, y })
        await Bun.sleep(200)
        const clicked = await viewState(app)
        await grab(path.join(OUT, 'clicked.png'))
        await app.call('keystrokes', { keys: keys('XY') })
        const expected = 'consXYt PORT = Number(process.env.PORT ?? 3000)'
        const paintedLine = await until('edited line painted', async () =>
          (await painted(app)).find((t) => t === expected)
        ).catch(() => null)
        const typed = await viewState(app)
        await grab(path.join(OUT, 'typed.png'))
        check(
          'a click at line 3 col 5 then XY edits that line, on screen',
          clicked.caret.line === 3 &&
            clicked.caret.col === 5 &&
            paintedLine === expected &&
            typed.caret.col === 7,
          {
            clickedCaret: clicked.caret,
            caretAfter: typed.caret,
            paintedLine
          }
        )

        const zone = { x: 548, y: 14, width: 30, height: 30 }
        cropPng(path.join(OUT, 'clicked.png'), zone, path.join(OUT, 'tab-clean.png'))
        cropPng(path.join(OUT, 'typed.png'), zone, path.join(OUT, 'tab-dirty.png'))
        const dirtyDiff = diffPngs(
          path.join(OUT, 'tab-clean.png'),
          path.join(OUT, 'tab-dirty.png'),
          path.join(OUT, 'tab-dirty-diff.png')
        )
        check(
          'the tab shows the dirty dot after an edit (tab close zone pixels change)',
          dirtyDiff.exact.mismatched > 10,
          {
            zone,
            pixelsChanged: dirtyDiff.exact.mismatched
          }
        )
        await app.call('keystrokes', { keys: 'ctrl-s' })
        const file = path.join(dir, 'src', 'app.ts')
        const saved = await until('saved to disk', async () => {
          const text = await readFile(file, 'utf8')
          return text.split('\n')[2] === expected ? text : null
        }).catch(() => null)
        check(
          'Ctrl+S writes the edit to disk',
          saved === APP_TS.replace('const PORT', 'consXYt PORT'),
          {
            line3OnDisk: (await readFile(file, 'utf8')).split('\n')[2]
          }
        )
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
        check(
          'Ctrl+Z undoes the edit (and the undo saves back the original bytes)',
          !!undone && restored,
          {
            undonePainted: !!undone,
            diskMatchesOriginal: restored
          }
        )
      }

      if (!only || only.has('readme')) {
        await openFromExplorer(app, ['README.md'])
        await app
          .getByTestId('markdown-preview')
          .waitFor({ timeoutMs: 15_000 })
          .catch(async (error) => {
            await grab(path.join(OUT, 'readme-failed.png'))
            throw error
          })
        await Bun.sleep(800)
        await grab(path.join(OUT, 'readme-preview.png'))
        const note =
          (await app.getByText('Mermaid diagrams show as source in this client.').count()) > 0
        await app.getByTestId('markdown-preview').click()
        editorId = 'code-editor-README.md'
        await app
          .getByTestId(editorId)
          .waitFor({ timeoutMs: 15_000 })
          .catch(async (error) => {
            await grab(path.join(OUT, 'readme-source-failed.png'))
            throw error
          })
        await until('README source painted', async () => (await painted(app)).includes('# alpha'))
        const box = await app.getByTestId(editorId).bounds()
        const view = await viewState(app)
        await app.mouse.click({ x: box.x + 34.484 + 6 + 7 * view.charWidth + 2, y: box.y + 4 + 10 })
        await app.call('keystrokes', { keys: keys(' edited') })
        await until('README edit painted', async () =>
          (await painted(app)).includes('# alpha edited')
        )
        await app.call('keystrokes', { keys: 'ctrl-s' })
        const file = path.join(dir, 'README.md')
        const saved = await until('README saved', async () =>
          (await readFile(file, 'utf8')).startsWith('# alpha edited\n') ? true : null
        ).catch(() => false)
        await Bun.sleep(300)
        await grab(path.join(OUT, 'readme-source.png'))
        check(
          'README.md opens in Preview with the mermaid note; a click edits the source; Ctrl+S saves',
          note && saved,
          {
            mermaidNote: note,
            line1OnDisk: (await readFile(file, 'utf8')).split('\n')[0]
          }
        )
      }

      if (!only || only.has('big')) {
        editorId = 'code-editor-big.ts'
        const clickAt = performance.now()
        await openFromExplorer(app, ['big.ts'])
        await app.getByTestId(editorId).waitFor({ timeoutMs: 20_000 })
        await until('big.ts first rows painted', async () =>
          (await painted(app)).some((t) => t.startsWith('/** Block 1:'))
        )
        const firstPaintMs = Math.round(performance.now() - clickAt)
        await Bun.sleep(1000)
        const box = await app.getByTestId(editorId).bounds()
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        const before = await viewState(app)
        const wheelStart = performance.now()
        for (let i = 0; i < 60; i++) {
          await app.mouse.wheel(center, 0, -60)
          await Bun.sleep(16)
        }
        const scrolled = await until('scrolled', async () => {
          const s = await viewState(app)
          return s.scrollTop > before.scrollTop ? s : null
        })
        const wheelMs = Math.round(performance.now() - wheelStart)
        await Bun.sleep(500)
        const afterScroll = (await viewState(app)) as ViewState & {
          perf?: { frames?: unknown; renderMs?: number[] }
        }
        await grab(path.join(OUT, 'big-scrolled.png'))
        await app.mouse.click({ x: box.x + 200, y: box.y + 100 })
        await Bun.sleep(200)
        const startCol = (await viewState(app)).caret.col
        for (let i = 0; i < 20; i++) {
          await app.call('keystrokes', { keys: 'q' })
          await Bun.sleep(60)
        }
        await until('typed run applied', async () =>
          (await viewState(app)).caret.col === startCol + 20 ? true : null
        )
        const end = (await viewState(app)) as ViewState & {
          perf?: { frames?: unknown; renderMs?: number[]; keyToCommitMs?: number[] }
        }
        const typed = (end.perf?.keyToCommitMs ?? []).slice(-20)
        const renders = (afterScroll.perf?.renderMs ?? []).slice(-60).sort((a, b) => a - b)
        const p = (q: number) =>
          renders[Math.min(renders.length - 1, Math.floor(q * renders.length))]
        check(
          'big.ts (5,000 lines): first paint, wheel scroll and typing timed',
          scrolled.lines === BIG_LINES + 1,
          {
            firstPaintMs,
            lines: scrolled.lines,
            wheelEvents: 60,
            wheelLoopMs: wheelMs,
            scrollTopAfter: afterScroll.scrollTop,
            frameStatsDuringScroll: afterScroll.perf?.frames,
            renderJsMs: { p50: p(0.5), p90: p(0.9), max: renders.at(-1), samples: renders.length },
            keyToCommitJsMs: typed,
            frameStatsAfterTyping: end.perf?.frames
          }
        )
        await app.call('keystrokes', { keys: 'ctrl-z' })
      }

      if (!only || only.has('crash')) {
        const termId = await openStatusBarTerminal(app, SIZE.height)
        const term = async () => (await terminals(app)).find((t) => t.testId === termId)
        await app.call('keystrokes', { keys: `${keys('echo before')} enter` })
        await until('terminal echoed', async () => rowMatching(await term(), /^before$/))
        await openFromExplorer(app, ['boom.gpuix-crash'])
        const fallback = await app
          .getByText('Something went wrong in Editor Tab')
          .waitFor({ timeoutMs: 15_000 })
          .then(() => true)
          .catch(() => false)
        await Bun.sleep(500)
        await grab(path.join(OUT, 'crash-tab.png'))
        const termTab = (await app.getByText('Terminal').all()).find(
          (n) => (n.bounds?.y ?? 1e9) < 48 && (n.bounds?.x ?? 0) > 470
        )
        if (termTab?.bounds) {
          await app.mouse.click({
            x: termTab.bounds.x + termTab.bounds.width / 2,
            y: termTab.bounds.y + termTab.bounds.height / 2
          })
        }
        await Bun.sleep(500)
        await app.mouse.click({ x: 900, y: 400 })
        await app.call('keystrokes', { keys: `${keys('echo alive')} enter` })
        const alive = await until('terminal still paints', async () =>
          rowMatching(await term(), /^alive$/)
        ).catch(() => null)
        await grab(path.join(OUT, 'crash-terminal.png'))
        check(
          'a tab that throws shows its own fallback; the terminal tab in the same pane still paints',
          fallback && !!alive,
          {
            fallback,
            terminalTabFound: !!termTab,
            aliveRow: alive?.text
          }
        )
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
