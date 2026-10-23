/**
 * The workspace terminal pane, end to end on GPUIX against a seeded
 * termul-server: open a terminal through the app's spawn path, type and read
 * rows, resize the window and read the PTY size the shell sees, switch
 * project and back (same shell process, same screen, time to paint), remount
 * the tree (cached screen), copy a selection and paste it, and click under a
 * program that tracks the mouse.
 *
 * bun tools/terminal/pane-check.ts [--out /tmp/gpuix-o1/pane] [--port 8193]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { APP_DIR } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { addProject, startTestServer } from '../parity/server'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../parity/shoot-gpuix'
import { buildScene } from './scene/build'
import type { PaneCommand, PaneSceneState, PaneTerminalState } from './scene/contract'
import { freePort, resizeWindow } from './shell-tree'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: '/tmp/gpuix-o1/pane' },
    port: { type: 'string' },
    root: { type: 'string', default: '/tmp/gpuix-o1' }
  }
})
const OUT = values.out!
const ROOT = values.root!
mkdirSync(OUT, { recursive: true })

const results: Record<string, unknown> = {}
const failures: string[] = []
function check(name: string, ok: boolean, detail: unknown): void {
  results[name] = { ok, detail }
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}

const port = Number(values.port ?? freePort())
const token = 'o1-pane-token'
const server = await startTestServer({ port, token, stateDir: path.join(ROOT, 'server') })
const projects = ['a', 'b'].map((id) => ({
  id: `o1-${id}`,
  name: `Project ${id.toUpperCase()}`,
  path: path.join(ROOT, 'projects', id),
  color: 'blue'
}))
for (const project of projects) await addProject(server, project)
writeFileSync(
  path.join(projects[0]!.path, 'mouse-echo.py'),
  readFileSync(path.join(import.meta.dir, 'scripts/mouse-echo.py'))
)

const entry = await buildScene()
const control = path.join(ROOT, 'pane-control.json')
const stateFile = path.join(ROOT, 'pane-state.json')
rmSync(control, { force: true })
rmSync(stateFile, { force: true })
const clientState = path.join(ROOT, 'client')
rmSync(clientState, { recursive: true, force: true })

const xvfb = await startXvfb(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN)
const app = await launch({
  command: 'bun',
  args: [entry],
  cwd: APP_DIR,
  env: {
    ...process.env,
    DISPLAY: xvfb.display,
    VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
    GPUIX_BACKGROUND: '1',
    TERMUL_SERVER_URL: server.baseUrl,
    TERMUL_SERVER_TOKEN: token,
    TERMUL_GPUIX_STATE_DIR: clientState,
    PANE_CONTROL: control,
    PANE_STATE: stateFile
  }
})

let seq = 0
function send(command: Omit<PaneCommand, 'seq'>): number {
  seq++
  writeFileSync(control, JSON.stringify({ ...command, seq }))
  return seq
}
function readState(): PaneSceneState | null {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as PaneSceneState
  } catch {
    return null
  }
}
async function until<T>(
  what: string,
  probe: (s: PaneSceneState) => T | null | undefined | false,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = readState()
    const hit = state ? probe(state) : null
    if (hit) return hit
    if (Date.now() > deadline)
      throw new Error(`timed out: ${what}; last state ${JSON.stringify(state)?.slice(0, 2000)}`)
    await Bun.sleep(50)
  }
}
const terminalIn = (s: PaneSceneState, projectId: string) =>
  s.terminals.find(
    (t) => t.projectId === projectId && t.ptyId && t.grid && t.visibleText.some((r) => r.trim())
  )
const textOf = (t: PaneTerminalState) => t.visibleText.join('\n')

async function type(storeId: string, text: string): Promise<void> {
  const node = await app.getByTestId(`terminal-${storeId}`).element()
  const keys = [...text].map((ch) => (ch === ' ' ? 'space' : ch)).join(' ')
  await app.call('keystrokes', { elementId: node.id, keys: `${keys} enter` })
}

async function shot(name: string): Promise<string> {
  const file = path.join(OUT, `${name}.png`)
  await Bun.sleep(300)
  const origin = await windowOrigin(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT).catch(() => ({
    x: 0,
    y: 0
  }))
  await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, file, origin)
  return file
}

try {
  const [a, b] = projects as [(typeof projects)[0], (typeof projects)[0]]
  send({ open: { projectId: a.id, cwd: a.path } })
  const first = await until('terminal in A shows a prompt', (s) => terminalIn(s, a.id), 30_000)
  const id = first.storeId
  await app.getByTestId(`terminal-${id}`).click()

  await type(id, 'echo hi')
  const echoed = await until('echo hi output', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t?.visibleText.some((row) => row.trim() === 'hi') ? t : null
  })
  check('echo-hi-row', true, { row: echoed.visibleText.findIndex((r) => r.trim() === 'hi') })
  await type(id, 'clear')
  await type(id, 'echo copyme')
  const copySource = await until('copyme row', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    const y = t?.visibleText.findIndex((r) => r.trim() === 'copyme') ?? -1
    return t && y >= 0 ? { t, y } : null
  })
  const g = copySource.t.grid!
  const rowY = g.y + (copySource.y + 0.5) * g.cellHeight
  // The pane pads the grid by the host's own padding (0) inside px-4 already in bounds.
  await app.mouse.drag(
    { x: g.x + 0.2 * g.cellWidth, y: rowY },
    { x: g.x + 6 * g.cellWidth, y: rowY },
    { steps: 6 }
  )
  const selected = await until(
    'drag selection',
    (s) => s.terminals.find((x) => x.storeId === id)?.selection === 'copyme' && 'copyme',
    3000
  ).catch(() => readState()?.terminals.find((x) => x.storeId === id)?.selection)
  check('drag-selects', selected === 'copyme', { selected })
  const node = await app.getByTestId(`terminal-${id}`).element()
  await app.call('keystrokes', { elementId: node.id, keys: 'ctrl-c' })
  await Bun.sleep(200)
  await app.call('keystrokes', { elementId: node.id, keys: 'e c h o space' })
  await Bun.sleep(200)
  await app.call('keystrokes', { elementId: node.id, keys: 'ctrl-v' })
  await Bun.sleep(300)
  await app.call('keystrokes', { elementId: node.id, keys: 'enter' })
  const pasted = await until('pasted copyme echoed', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return (t?.visibleText.filter((r) => r.trim() === 'copyme').length ?? 0) >= 2 ? t : null
  })
  check('copy-paste-roundtrip', true, {
    rows: pasted.visibleText.filter((r) => r.trim() === 'copyme').length
  })
  {
    const y2 = pasted.visibleText.findIndex((r) => r.trim() === 'copyme')
    const ry = g.y + (y2 + 0.5) * g.cellHeight
    await app.mouse.drag(
      { x: g.x + 0.2 * g.cellWidth, y: ry },
      { x: g.x + 4 * g.cellWidth, y: ry },
      { steps: 6 }
    )
    const again = await until(
      'second drag',
      (s) => s.terminals.find((x) => x.storeId === id)?.selection === 'copy' && 'copy',
      3000
    ).catch(() => readState()?.terminals.find((x) => x.storeId === id)?.selection)
    check('second-drag-selects', again === 'copy', { again })
  }

  await type(id, 'stty size')
  const sizeBefore = await until('stty size before resize', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    const row = t?.visibleText.find((r) => /^\d+ \d+$/.test(r.trim()))
    return row && t ? { pty: row.trim(), screen: `${t.rows} ${t.cols}` } : null
  })
  check('pty-size-matches-screen', sizeBefore.pty === sizeBefore.screen, sizeBefore)

  const FULL = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }
  const SMALL = { width: 1000, height: 640 }
  resizeWindow(xvfb.display, FULL, SMALL)
  const resized = await until('screen refit after window resize', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t && `${t.rows} ${t.cols}` !== sizeBefore.screen ? t : null
  })
  await Bun.sleep(600)
  await type(id, 'clear')
  await until('cleared', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t && !t.visibleText.some((r) => /^\d+ \d+$/.test(r.trim()))
  })
  await type(id, 'stty size')
  const sizeAfter = await until('stty size after resize', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    const row = t?.visibleText.find((r) => /^\d+ \d+$/.test(r.trim()))
    return row && t ? { pty: row.trim(), screen: `${t.rows} ${t.cols}` } : null
  })
  check(
    'resize-reaches-pty',
    sizeAfter.pty !== sizeBefore.pty && sizeAfter.pty === sizeAfter.screen,
    {
      before: sizeBefore,
      after: sizeAfter,
      screen: [resized.cols, resized.rows]
    }
  )
  resizeWindow(xvfb.display, SMALL, FULL)
  await until('screen refit at full size', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t && `${t.rows} ${t.cols}` === sizeBefore.screen
  })
  await Bun.sleep(600)

  {
    const cur = readState()!.terminals.find((x) => x.storeId === id)!
    const yy = cur.visibleText.findIndex((r) => /^\d+ \d+$/.test(r.trim()))
    const gg = cur.grid!
    const ry = gg.y + (yy + 0.5) * gg.cellHeight
    await app.mouse.drag(
      { x: gg.x + 0.2 * gg.cellWidth, y: ry },
      { x: gg.x + 2 * gg.cellWidth, y: ry },
      { steps: 6 }
    )
    const sel = await until(
      'drag after resize',
      (s) => s.terminals.find((x) => x.storeId === id)?.selection,
      3000
    ).catch(() => '')
    check('drag-after-resize', !!sel, { sel })
  }
  await type(id, 'echo PID=$$')
  const pidOf = (t: PaneTerminalState | undefined) =>
    t?.visibleText
      .map((r) => r.trim().match(/^PID=(\d+)$/)?.[1])
      .filter(Boolean)
      .at(-1)
  const pid = await until('shell pid', (s) => pidOf(s.terminals.find((x) => x.storeId === id)))
  await Bun.sleep(300)
  const beforeSwitch = readState()!.terminals.find((x) => x.storeId === id)!
  results.shotBeforeSwitch = await shot('before-switch')

  send({ open: { projectId: b.id, cwd: b.path } })
  const other = await until(
    'terminal in B',
    (s) => s.activeProjectId === b.id && terminalIn(s, b.id)
  )
  check('switched-to-b', true, { otherPty: other.ptyId })
  results.shotProjectB = await shot('project-b')
  const hiddenA = readState()!.terminals.find((x) => x.storeId === id)!
  check('a-pty-kept-while-hidden', hiddenA.ptyId === beforeSwitch.ptyId, { ptyId: hiddenA.ptyId })

  const median = (xs: number[]) => [...xs].sort((p, q) => p - q)[xs.length >> 1]!
  const pings: Array<{ commitMs: number; frameMs: number | null }> = []
  for (let i = 0; i < 5; i++) {
    send({ ping: true })
    pings.push(
      await until('ping painted', (s) => s.seq === seq && s.lastPing?.frameMs != null && s.lastPing)
    )
    await Bun.sleep(200)
  }
  const switches: Array<NonNullable<PaneSceneState['lastSwitch']>> = []
  for (let i = 0; i < 4; i++) {
    for (const target of [a.id, b.id]) {
      send({ switchTo: target })
      switches.push(
        await until('switch painted', (s) =>
          s.seq === seq && s.lastSwitch?.projectId === target && s.lastSwitch.frameMs !== null
            ? s.lastSwitch
            : null
        )
      )
      await Bun.sleep(200)
    }
  }
  results.switchTiming = {
    pingCommitMedian: median(pings.map((p) => p.commitMs)),
    pingFrameMedian: median(pings.map((p) => p.frameMs!)),
    switchCommitMedian: median(switches.map((x) => x.commitMs)),
    switchFrameMedian: median(switches.map((x) => x.frameMs!)),
    pings,
    switches
  }
  send({ switchTo: a.id })
  const back = await until('switch back to A painted', (s) =>
    s.activeProjectId === a.id && s.lastSwitch?.projectId === a.id && s.lastSwitch.frameMs !== null
      ? s
      : null
  )
  const afterSwitch = back.terminals.find((x) => x.storeId === id)!
  check('restored-same-pty', afterSwitch.ptyId === beforeSwitch.ptyId, { ptyId: afterSwitch.ptyId })
  check('restored-same-screen', back.screensBuilt[id] === 1, {
    screensBuilt: back.screensBuilt[id]
  })
  check('restored-text-identical', textOf(afterSwitch) === textOf(beforeSwitch), {
    rows: afterSwitch.visibleText.filter((r) => r.trim()).length
  })
  const timing = results.switchTiming as { switchFrameMedian: number; pingFrameMedian: number }
  // The scene's clocks include the harness's polling and lavapipe's CPU raster, so the
  // switch is judged against a trivial update measured the same way.
  check('restore-paint-ms', timing.switchFrameMedian <= timing.pingFrameMedian * 2 + 50, {
    last: back.lastSwitch,
    ...timing,
    publishMs: back.publishMs
  })
  results.shotAfterSwitch = await shot('after-switch')
  await type(id, 'echo PID=$$')
  await until('second pid line', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return (t?.visibleText.filter((r) => /^PID=\d+$/.test(r.trim())).length ?? 0) >= 2
  })
  const pidAgain = pidOf(readState()!.terminals.find((x) => x.storeId === id))
  check('same-shell-process', pidAgain === pid && existsSync(`/proc/${pid}`), { pid, pidAgain })

  await type(id, 'clear')
  await type(id, 'echo second')
  const second = await until('second row', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    const y = t?.visibleText.findIndex((r) => r.trim() === 'second') ?? -1
    return t && y >= 0 ? { t, y } : null
  })
  {
    const sg = second.t.grid!
    const sy = sg.y + (second.y + 0.5) * sg.cellHeight
    await app.mouse.drag(
      { x: sg.x + 0.2 * sg.cellWidth, y: sy },
      { x: sg.x + 6 * sg.cellWidth, y: sy },
      { steps: 6 }
    )
    const sel = await until(
      'selection after switch',
      (s) => s.terminals.find((x) => x.storeId === id)?.selection === 'second' && 'second',
      3000
    ).catch(() => readState()?.terminals.find((x) => x.storeId === id)?.selection)
    send({ hit: { x: sg.x + 3 * sg.cellWidth, y: sy } })
    const hit = await until('hit probe', (s) => s.seq === seq && s.hit)
    check('drag-selects-after-switch', sel === 'second', { sel, hit })
  }
  const beforeRemount = readState()!.terminals.find((x) => x.storeId === id)!
  const remountAt = performance.now()
  send({ remount: true })
  await until('remounted', (s) => s.seq === seq)
  await Bun.sleep(400)
  const remounted = readState()!
  const afterRemount = remounted.terminals.find((x) => x.storeId === id)!
  check(
    'remount-reuses-cached-screen',
    remounted.screensBuilt[id] === 1 && textOf(afterRemount) === textOf(beforeRemount),
    {
      screensBuilt: remounted.screensBuilt[id],
      ms: Math.round(performance.now() - remountAt)
    }
  )

  await type(id, 'clear')
  await type(id, `python3 ${path.join(a.path, 'mouse-echo.py')}`)
  const ready = await until('mouse program ready', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t?.grid && t.visibleText.some((r) => r.includes('MOUSE-READY')) ? t : null
  })
  const col = 10
  const row = 5
  const target = {
    x: ready.grid!.x + (col + 0.5) * ready.grid!.cellWidth,
    y: ready.grid!.y + (row + 0.5) * ready.grid!.cellHeight
  }
  await app.mouse.click(target)
  const report = await until('mouse report', (s) => {
    const t = s.terminals.find((x) => x.storeId === id)
    return t?.visibleText.map((r) => r.match(/MOUSE=([0-9a-f]*)/)?.[1]).find(Boolean)
  })
  const bytes = Buffer.from(report, 'hex').toString('latin1')
  const expected = `\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`
  check('mouse-sgr-click-bytes', bytes === expected, {
    got: JSON.stringify(bytes),
    expected: JSON.stringify(expected)
  })
  results.shotFinal = await shot('final')
} catch (error) {
  failures.push(`error: ${String(error)}`)
  console.error(error)
  results.shotError = await shot('error').catch(() => null)
} finally {
  await app.close().catch(() => {})
  xvfb.stop()
  await server.stop()
}

writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, failures }, null, 2))
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED')
process.exit(failures.length ? 1 : 0)
