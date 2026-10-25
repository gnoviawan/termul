/**
 * Are onFocus/onBlur delivered on Linux? Runs `focus-scene.tsx` under Xvfb
 * twice: with the window left inactive (no window manager runs, so nothing
 * gives it the X input focus) and with the window made active the way a
 * window manager does on map (`tools/matrix/x11-focus.py`). The active run
 * must get exactly the DOM's focus and blur events at every step
 * (`focus-steps.ts`), including blur and focus when the window loses and
 * regains the X input focus. The inactive run is printed for reference.
 *
 * bun tools/native/focus-check.ts [--out DIR]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { activateWindow } from '../matrix/drive'
import { LAVAPIPE_ICD, SCREEN_MARGIN, startXvfb, windowOrigin } from '../parity/shoot-gpuix'
import { FOCUS_STEPS } from './focus-steps'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string', default: '/tmp/gpuix-focus-check' } }
})
const out = path.resolve(values.out as string)
const SIZE = { width: 320, height: 200 }
type Steps = Array<{ step: string; focused: string | null; events: string[] }>

async function waitFor(file: string, scene: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!existsSync(file)) {
    if (scene.exitCode !== null) throw new Error(`focus scene exited ${scene.exitCode}`)
    if (Date.now() > deadline) throw new Error(`no ${path.basename(file)}`)
    await Bun.sleep(20)
  }
}

async function unfocusWindow(display: string): Promise<void> {
  const proc = Bun.spawn(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      path.join(import.meta.dir, 'x11-unfocus.py')
    ],
    { env: { ...process.env, DISPLAY: display }, stdout: 'ignore', stderr: 'pipe' }
  )
  if ((await proc.exited) !== 0)
    throw new Error(`x11-unfocus failed: ${await new Response(proc.stderr).text()}`)
}

// xwininfo lists the window before it is mapped, and an unmapped window is
// not at its point yet.
async function activateMapped(display: string, origin: { x: number; y: number }): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      return await activateWindow(display, origin)
    } catch (error) {
      if (Date.now() > deadline) throw error
      await Bun.sleep(200)
    }
  }
}

async function run(active: boolean): Promise<Steps> {
  const dir = path.join(out, active ? 'active' : 'inactive')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const xvfb = await startXvfb(SIZE.width + SCREEN_MARGIN, SIZE.height + SCREEN_MARGIN)
  const scene = Bun.spawn(['bun', path.join(import.meta.dir, 'focus-scene.tsx'), dir], {
    env: {
      ...process.env,
      DISPLAY: xvfb.display,
      VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
      GPUIX_BACKGROUND: '1'
    },
    stdout: 'ignore',
    stderr: 'ignore'
  })
  try {
    const origin = await windowOrigin(xvfb.display, SIZE.width, SIZE.height)
    if (active) await activateMapped(xvfb.display, origin)
    for (const [n, step] of FOCUS_STEPS.entries()) {
      if (active && step.id === 'deactivate') await unfocusWindow(xvfb.display)
      if (active && step.id === 'reactivate') await activateMapped(xvfb.display, origin)
      writeFileSync(path.join(dir, `go-${n}`), '')
      await waitFor(path.join(dir, `done-${n}`), scene)
    }
    await waitFor(path.join(dir, 'result.json'), scene)
    return JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8')) as Steps
  } finally {
    scene.kill()
    await scene.exited
    xvfb.stop()
  }
}

let failed = false
for (const active of [false, true]) {
  const steps = await run(active)
  for (const [n, { focused, events }] of steps.entries()) {
    const step = FOCUS_STEPS[n]
    if (!step) continue
    const ok = JSON.stringify(events) === JSON.stringify(step.dom)
    if (active && !ok) failed = true
    const verdict = active ? (ok ? 'PASS' : 'FAIL') : 'INFO'
    console.log(
      `${verdict} ${active ? 'active' : 'inactive'} window, ${step.what}: focused ${focused}, events ${JSON.stringify(events)}${active ? `, DOM ${JSON.stringify(step.dom)}` : ''}`
    )
  }
}
if (failed) process.exit(1)
