/**
 * The terminal acceptance checks inside the real app shell (`src/renderer/App.tsx`
 * through compat, with the native terminal overrides): the status-bar
 * Terminal button opens a workspace terminal tab, typed keys reach the shell,
 * a window resize reaches the PTY, a project switch away and back keeps the
 * same shell with its screen painted at once, a selection copies and pastes
 * back, and a click under a mouse-tracking program sends SGR bytes.
 *
 * Rows are read from the automation tree: each terminal row is one child of
 * the `terminal-<store id>` element, its text the concatenation of its runs.
 *
 * bun tools/terminal/shell-check.ts [--port N] [--out DIR] [--state-dir DIR]
 */
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { buildClient } from '../../build'
import { startTestServer } from '../parity/server'
import { grabFrame, READY_TIMEOUT_MS, windowOrigin, withGpuix } from '../parity/shoot-gpuix'
import { seedWorkspace } from '../parity/workspace'
import {
  openStatusBarTerminal,
  resizeWindow,
  rowMatching,
  terminals,
  until
} from './shell-tree'

function freePort(): number {
  const listening = Bun.spawnSync(['ss', '-ltnH']).stdout.toString()
  for (let port = 8190; port <= 8199; port++) if (!listening.includes(`:${port} `)) return port
  throw new Error('no free port in 8190-8199')
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string' },
    out: { type: 'string', default: '/tmp/gpuix-o1/shell' },
    'state-dir': { type: 'string', default: '/tmp/gpuix-o1/shell-state' }
  }
})
const OUT = values.out!
const stateDir = values['state-dir']!
const SIZE = { width: 1280, height: 800 }
const SMALL = { width: 1000, height: 700 }
const results: Array<{ check: string; ok: boolean; detail: unknown }> = []
function check(name: string, ok: boolean, detail: unknown): void {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

const build = await buildClient()
if (!build.ok) {
  for (const line of build.logs) console.error(line)
  process.exit(1)
}
await rm(stateDir, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
const server = await startTestServer({
  port: Number(values.port ?? freePort()),
  token: 'o1-shell-token',
  stateDir: path.join(stateDir, 'server')
})
try {
  await seedWorkspace(server)
  const alphaDir = path.join(server.stateDir, 'projects', 'alpha')
  await copyFile(
    path.join(import.meta.dir, 'scripts/mouse-echo.py'),
    path.join(alphaDir, 'mouse-echo.py')
  )
  await withGpuix(
    { server, entry: build.entry, clientStateDir: path.join(stateDir, 'client'), ...SIZE },
    async ({ app, display, grab }) => {
      await app.getByText('What should we do in alpha?').waitFor({ timeoutMs: READY_TIMEOUT_MS })
      const testId = await openStatusBarTerminal(app, SIZE.height)
      const term = async () => (await terminals(app)).find((t) => t.testId === testId)
      const keys = async (text: string) => {
        const node = await app.getByTestId(testId).element()
        await app.call('keystrokes', { elementId: node.id, keys: text })
      }
      const type = (text: string) =>
        keys(`${[...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')} enter`)

      const typeFocused = (text: string) =>
        app.call('keystrokes', {
          keys: `${[...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')} enter`
        })

      await typeFocused('echo hi')
      const hiRows = await until('echo hi output', async () => {
        const rows = (await term())?.rows
        return rows && rowMatching({ testId, rows }, /^hi$/) ? rows : null
      })
      check('status-bar Terminal opens a focused tab; typed echo hi prints its row', true, {
        testId,
        row: hiRows.findIndex((r) => r.text.trim() === 'hi')
      })
      await app.getByTestId('project-item-parity-alpha').click()
      const pane = await app.getByTestId(testId).bounds()
      await app.mouse.click({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
      await typeFocused('echo clicked')
      const clicked = await until('typed after a click', async () =>
        rowMatching(await term(), /^clicked$/)
      ).catch(() => null)
      check('a click in the pane focuses the terminal for typing', !!clicked, {})
      await grab(path.join(OUT, 'terminal-open.png'))

      await type('clear')
      await type('echo copyme')
      const source = await until('copyme row', async () => rowMatching(await term(), /^copyme$/))
      const cw = source.cellWidth ?? 8
      const midY = source.y + source.height / 2
      await app.mouse.drag(
        { x: source.x + 0.2 * cw, y: midY },
        { x: source.x + 6 * cw, y: midY },
        { steps: 6 }
      )
      await keys('ctrl-c')
      await Bun.sleep(200)
      await keys('e c h o space')
      await keys('ctrl-v')
      await Bun.sleep(300)
      await keys('enter')
      const pasted = await until('pasted copyme echoed', async () => {
        const rows = (await term())?.rows.filter((r) => r.text.trim() === 'copyme') ?? []
        return rows.length >= 2 ? rows : null
      }).catch(() => [])
      check('copy a selection and paste it back', pasted.length >= 2, {
        copymeRows: pasted.length,
        measuredCellWidth: source.cellWidth
      })

      await type('clear')
      await type('stty size')
      const sizeBefore = (
        await until('stty size', async () => rowMatching(await term(), /^\d+ \d+$/))
      ).text.trim()
      resizeWindow(display, SIZE, SMALL)
      await Bun.sleep(1500)
      await type('clear')
      await until('cleared', async () => !rowMatching(await term(), /^\d+ \d+$/))
      await type('stty size')
      const sizeAfter = (
        await until('stty size after resize', async () => rowMatching(await term(), /^\d+ \d+$/))
      ).text.trim()
      const [rowsBefore, colsBefore] = sizeBefore.split(' ').map(Number) as [number, number]
      const [rowsAfter, colsAfter] = sizeAfter.split(' ').map(Number) as [number, number]
      check('window resize reaches the PTY', rowsAfter < rowsBefore && colsAfter < colsBefore, {
        before: sizeBefore,
        after: sizeAfter
      })
      await grabFrame(
        display,
        SMALL.width,
        SMALL.height,
        path.join(OUT, 'after-resize.png'),
        await windowOrigin(display, SMALL.width, SMALL.height)
      )
      resizeWindow(display, SMALL, SIZE)
      await Bun.sleep(1500)

      await type('clear')
      await type('echo PID=$$')
      const pid = (
        await until('shell pid', async () => rowMatching(await term(), /^PID=\d+$/))
      ).text
        .trim()
        .slice(4)
      const screenBefore = (await term())!.rows.map((r) => r.text)
      const shellParent = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[3]
      const parentCmd = readFileSync(`/proc/${shellParent}/cmdline`, 'utf8').split('\0')
      const ownedByTestServer =
        parentCmd[0]?.endsWith('termul-server') === true && parentCmd.includes(server.stateDir)

      const betaClick = performance.now()
      await app.getByTestId('project-item-parity-beta').click()
      await app.getByText('What should we do in beta?').waitFor({ timeoutMs: 10_000 })
      const betaMs = Math.round(performance.now() - betaClick)
      const hiddenRows = (await term())?.rows.length ?? 0
      await grab(path.join(OUT, 'project-beta.png'))
      const aliveAway = existsSync(`/proc/${pid}`)

      const alphaClick = performance.now()
      await app.getByTestId('project-item-parity-alpha').click()
      await until(
        'PID row painted again',
        async () => rowMatching(await term(), /^PID=\d+$/),
        10_000
      )
      const backMs = Math.round(performance.now() - alphaClick)
      const treeAt = performance.now()
      const screenAfter = (await term())!.rows.map((r) => r.text)
      const oneTreeReadMs = Math.round(performance.now() - treeAt)
      await grab(path.join(OUT, 'after-switch.png'))
      await type('echo PID=$$')
      const pids = await until('second pid row', async () => {
        const rows =
          (await term())?.rows.map((r) => r.text.trim()).filter((t) => /^PID=\d+$/.test(t)) ?? []
        return rows.length >= 2 ? rows : null
      })
      check(
        'switch away and back keeps the shell and restores its screen at once',
        ownedByTestServer &&
          aliveAway &&
          pids.every((p) => p === `PID=${pid}`) &&
          screenAfter.join('\n') === screenBefore.join('\n') &&
          backMs <= betaMs * 2 + 100,
        {
          pid,
          shellParentPid: shellParent,
          ownedByTestServer,
          aliveWhileAway: aliveAway,
          rowsPaintedWhileAway: hiddenRows,
          screenIdentical: screenAfter.join('\n') === screenBefore.join('\n'),
          pids,
          switchToBetaPaintedMs: betaMs,
          switchBackTerminalPaintedMs: backMs,
          oneTreeReadMs
        }
      )

      await type('clear')
      await type('python3 mouse-echo.py')
      const ready = await until('mouse program ready', async () =>
        rowMatching(await term(), /MOUSE-READY/)
      )
      const grid = (await term())!.rows[0]!
      const col = 10
      const row = 5
      await app.mouse.click({
        x: grid.x + (col + 0.5) * (ready.cellWidth ?? cw),
        y: grid.y + (row + 0.5) * grid.height
      })
      const report = await until('mouse report', async () =>
        (await term())?.rows.map((r) => r.text.match(/MOUSE=([0-9a-f]*)/)?.[1]).find(Boolean)
      )
      const bytes = Buffer.from(report, 'hex').toString('latin1')
      const expected = `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`
      check('click under mouse=SGR program sends the report bytes', bytes === expected, {
        got: JSON.stringify(bytes),
        expected: JSON.stringify(expected)
      })
      await grab(path.join(OUT, 'final.png'))
    }
  )
} catch (error) {
  check('error', false, String(error))
} finally {
  await server.stop()
}
await Bun.write(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2))
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1)
