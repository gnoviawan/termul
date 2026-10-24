/**
 * `bun tools/clickloss/run.ts [--trials N] [--modes a,b] [--targets row,gear] [--port N] [--xvfb-args "..."]`
 *
 * Lost-press repro on the real rail. Seeds the matrix world, launches the
 * client with `COMPAT_TRACE_POINTER=1`, and clicks rail rows (success: the
 * dashboard of that project shows) and the hover-revealed gear (success: the
 * Project settings modal shows), each through one input path:
 *
 * - `auto`: GPUIX automation `click` at the point, no move first.
 * - `auto-move`: automation `mouseMove` to the point, then `click`.
 * - `xtest`: real X input through XTEST (`tools/matrix/x11-click.py`).
 * - `xtest-nofocus`: XTEST without the script's set_input_focus.
 *
 * Prints successes per mode and target, and for each failure the compat
 * trace lines of the trial (which listener fired, on what, GPUI's hit list).
 * State and logs go under $GPUIX_STATE_ROOT (default /tmp/gpuix-h1).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from '@gpuix/react/automation'
import { buildClient } from '../../build'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { LAVAPIPE_ICD, READY_TIMEOUT_MS, SCREEN_MARGIN, windowOrigin } from '../parity/shoot-gpuix'
import { pickPort, stateRoot } from '../shared/seed'
import { createWorld, PROJECTS, prepareDevice, setTheme } from '../matrix/world'
import { startX, waitForQuietHost, type XServer } from './x'

type Mode = 'auto' | 'auto-move' | 'xtest' | 'xtest-nofocus'
type Target = 'row' | 'gear'
type App = Awaited<ReturnType<typeof launch>>
interface Point {
  x: number
  y: number
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    trials: { type: 'string', default: '10' },
    modes: { type: 'string', default: 'auto,auto-move,xtest' },
    targets: { type: 'string', default: 'row,gear' },
    port: { type: 'string' },
    'xvfb-args': { type: 'string', default: '' },
    'no-build': { type: 'boolean', default: false }
  }
})

const STATE = stateRoot('/tmp/gpuix-h1')
const MODES = (values.modes as string).split(',') as Mode[]
const TARGETS = (values.targets as string).split(',') as Target[]
const TRIALS = Number(values.trials)
const ROWS = ['beta', 'gamma', 'alpha'] as const
const SETTINGS_TEXT = 'Basic project identification and location.'
const BOOT_TEXT = 'What should we do in alpha?'
const X11_CLICK = path.join(import.meta.dir, 'x11-press.py')

const dashboard = (name: string) => `What should we do in ${name}?`

async function seen(app: App, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await app.getByText(text).count()) > 0) return true
    await Bun.sleep(100)
  }
  return false
}

async function centre(app: App, testId: string): Promise<Point> {
  const b = await app.getByTestId(testId).bounds()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function xtest(x: XServer, origin: Point, p: Point, focus: boolean): Promise<void> {
  const proc = Bun.spawn(
    ['uv', 'run', '--quiet', '--with', 'python-xlib==0.33', 'python', '-I', X11_CLICK,
      String(Math.round(origin.x + p.x)), String(Math.round(origin.y + p.y)), focus ? 'focus' : 'nofocus'],
    { env: { ...process.env, DISPLAY: x.display }, stdout: 'ignore', stderr: 'pipe' }
  )
  if ((await proc.exited) !== 0) throw new Error(`x11-press: ${await new Response(proc.stderr).text()}`)
}

async function xmove(x: XServer, origin: Point, p: Point): Promise<void> {
  const proc = Bun.spawn(
    ['uv', 'run', '--quiet', '--with', 'python-xlib==0.33', 'python', '-I', X11_CLICK,
      String(Math.round(origin.x + p.x)), String(Math.round(origin.y + p.y)), 'move'],
    { env: { ...process.env, DISPLAY: x.display }, stdout: 'ignore', stderr: 'pipe' }
  )
  if ((await proc.exited) !== 0) throw new Error(`x11-press: ${await new Response(proc.stderr).text()}`)
}

interface Input {
  move(p: Point): Promise<void>
  click(p: Point): Promise<void>
}

function input(mode: Mode, app: App, x: XServer, origin: Point): Input {
  switch (mode) {
    case 'auto':
      return { move: (p) => app.call('mouseMove', p).then(() => {}), click: (p) => app.call('click', { ...p, button: 0 }).then(() => {}) }
    case 'auto-move':
      return {
        move: (p) => app.call('mouseMove', p).then(() => {}),
        click: async (p) => {
          await app.call('mouseMove', p)
          await Bun.sleep(150)
          await app.call('click', { ...p, button: 0 })
        }
      }
    case 'xtest':
    case 'xtest-nofocus':
      return { move: (p) => xmove(x, origin, p), click: (p) => xtest(x, origin, p, mode === 'xtest') }
  }
}

/** A point away from the rail, to start each trial from a moved pointer. */
const PARK: Point = { x: 700, y: 400 }

async function trial(app: App, inp: Input, target: Target, name: string): Promise<boolean> {
  const id = PROJECTS[name as keyof typeof PROJECTS].id
  await inp.move(PARK)
  await Bun.sleep(200)
  const row = await centre(app, `project-item-${id}`)
  if (target === 'row') {
    await inp.click(row)
    return seen(app, dashboard(name), 3000)
  }
  await inp.move(row)
  const actions = app.getByTestId('project-row-actions')
  const deadline = Date.now() + 3000
  let gear: Point | null = null
  while (Date.now() < deadline && !gear) {
    for (const node of await actions.all()) {
      const b = node.bounds
      if (b && b.y <= row.y && row.y <= b.y + b.height) gear = { x: b.x + 24 + 10, y: b.y + b.height / 2 }
    }
    if (!gear) await Bun.sleep(100)
  }
  if (!gear) throw new Error(`row ${name} hover did not reveal its actions`)
  await inp.click(gear)
  const ok = await seen(app, SETTINGS_TEXT, 3000)
  if (ok) {
    await app.call('keystrokes', { keys: 'escape' })
    for (let i = 0; i < 30 && (await app.getByText(SETTINGS_TEXT).count()) > 0; i++) await Bun.sleep(100)
  }
  return ok
}

async function main(): Promise<void> {
  mkdirSync(STATE, { recursive: true })
  await waitForQuietHost()
  const build = values['no-build'] ? { ok: true, entry: path.join(import.meta.dir, '../../dist/main.js'), logs: [] } : await buildClient()
  if (!build.ok) {
    for (const line of build.logs) console.error(line)
    process.exit(1)
  }
  const port = await pickPort(values.port ? Number(values.port) : undefined)
  const root = path.join(STATE, 'world')
  await rm(root, { recursive: true, force: true })
  console.error(`[clickloss] seeding server on ${port} under ${root}`)
  const world = await createWorld({ port, root })
  const results: Record<string, { ok: number; total: number; failures: string[] }> = {}
  try {
    for (const mode of MODES) {
      const deviceId = `h1-${mode}`
      await prepareDevice(world, deviceId)
      await setTheme(world, 'termul', 'dark')
      const clientStateDir = path.join(STATE, 'clients', mode)
      await rm(clientStateDir, { recursive: true, force: true })
      const host = new URL(world.server.baseUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')
      mkdirSync(path.join(clientStateDir, 'web-storage'), { recursive: true })
      writeFileSync(path.join(clientStateDir, 'web-storage', `${host}.json`), JSON.stringify({ 'termul.deviceId': deviceId }))
      const stderrFile = path.join(STATE, `stderr-${mode}.log`)
      writeFileSync(stderrFile, '')
      const xs = await startX(WINDOW_WIDTH + SCREEN_MARGIN, WINDOW_HEIGHT + SCREEN_MARGIN, (values['xvfb-args'] as string).split(' ').filter(Boolean))
      try {
        const app = await launch({
          command: 'sh',
          args: ['-c', 'exec bun "$0" 2>>"$1"', build.entry, stderrFile],
          cwd: path.dirname(build.entry),
          env: {
            ...process.env,
            DISPLAY: xs.display,
            VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
            GPUIX_BACKGROUND: '1',
            GPUIX_WINDOW_SIZE: `${WINDOW_WIDTH}x${WINDOW_HEIGHT}`,
            TERMUL_SERVER_URL: world.server.baseUrl,
            TERMUL_SERVER_TOKEN: world.server.token,
            TERMUL_GPUIX_STATE_DIR: clientStateDir,
            COMPAT_TRACE_POINTER: '1'
          }
        })
        try {
          await app.getByText(BOOT_TEXT).waitFor({ timeoutMs: READY_TIMEOUT_MS })
          await Bun.sleep(1000)
          const origin = await windowOrigin(xs.display, WINDOW_WIDTH, WINDOW_HEIGHT)
          const inp = input(mode, app, xs, origin)
          for (const target of TARGETS) {
            const key = `${mode}/${target}`
            const r = (results[key] = { ok: 0, total: 0, failures: [] as string[] })
            for (let i = 0; i < TRIALS; i++) {
              const name = target === 'row' ? ROWS[i % ROWS.length] : 'beta'
              const before = readFileSync(stderrFile, 'utf8').length
              let ok = false
              let error = ''
              try {
                ok = await trial(app, inp, target, name)
              } catch (e) {
                error = e instanceof Error ? e.message : String(e)
              }
              r.total++
              if (ok) r.ok++
              else {
                const trace = readFileSync(stderrFile, 'utf8')
                  .slice(before)
                  .split('\n')
                  .filter((l) => l.includes('[compat-trace]') && !/ (move|source-move) /.test(l))
                r.failures.push(`#${i} ${name}${error ? ` error=${error}` : ''}\n    ${trace.slice(-12).join('\n    ')}`)
              }
              console.error(`[clickloss] ${key} #${i} ${name}: ${ok ? 'ok' : 'LOST'}${error ? ` (${error})` : ''}`)
            }
          }
        } finally {
          await app.close()
        }
      } finally {
        xs.stop()
      }
    }
  } finally {
    world.ws.close()
    await world.server.stop()
  }
  for (const [key, r] of Object.entries(results)) {
    console.log(`${key.padEnd(22)} ${r.ok}/${r.total}`)
    for (const f of r.failures) console.log(`  ${f}`)
  }
  const failed = Object.values(results).some((r) => r.ok !== r.total)
  process.exit(failed ? 1 : 0)
}

await main()
