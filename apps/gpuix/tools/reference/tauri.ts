/**
 * The `tauri` reference: the shipped desktop app (Tauri on WebKitGTK), for a
 * surface the web client cannot render. WebKitGTK has no automation hook on
 * this host (no WebKitWebDriver), so the app is driven like a user drives it,
 * with XTEST keys and clicks, and read only through its pixels.
 *
 * Every session gets a fresh throwaway HOME (and XDG dirs) under the state
 * root, so the app never opens the real desktop data dir, and the seeded
 * projects are the matrix world's own folders. Build the app from the same
 * checkout as the GPUIX client under test:
 *
 *   CARGO_TARGET_DIR=/root/termul-wt/gpuix/src-tauri/target \
 *     bun x tauri build --config src-tauri/tauri.conf.dev.json --no-bundle
 *
 * `TERMUL_TAURI_BIN` picks another binary.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { xinput } from '../browser/probes'
import { type Driver, describe, type Point } from '../matrix/drive'
import type { Action, ActionLog, AppStores } from '../matrix/types'
import { PROJECTS, type ProjectKey, type World } from '../matrix/world'
import { grabFrame, SCREEN_MARGIN, startSessionBus, startXvfb } from '../parity/shoot-gpuix'

export const TAURI_BIN =
  process.env.TERMUL_TAURI_BIN ?? '/root/termul-wt/gpuix/src-tauri/target/release/termul-manager'
/** `tauri.conf.dev.json`'s identifier: the data dir the build reads. */
const IDENTIFIER = 'com.termul-manager.app.dev'
const WINDOW_TITLE = 'Termul Manager'
const READY_TIMEOUT_MS = 90_000
const SETTLE_TIMEOUT_MS = 20_000
/** alpha's avatar in the rail, `blue` as the app paints it. */
const AVATAR_RGB = [60, 131, 246]
const X11_WINDOW = path.join(import.meta.dir, 'x11-window.py')

export interface TauriSession {
  display: string
  origin: Point
  grab(outPath: string): Promise<void>
}

/**
 * projects.json as the desktop app keeps it (schema 4), listing the world's
 * projects in order, and the plugin-store files the surface starts with.
 */
function seedDataDir(home: string, world: World, stores: AppStores = {}): void {
  const dataDir = path.join(home, '.local/share', IDENTIFIER)
  mkdirSync(dataDir, { recursive: true })
  const projects = (Object.keys(PROJECTS) as ProjectKey[]).map((key) => ({
    ...PROJECTS[key],
    path: world.dirs[key],
    isArchived: false,
    mcpServers: []
  }))
  writeFileSync(
    path.join(dataDir, 'projects.json'),
    JSON.stringify({ schemaVersion: 4, projects, imported: false })
  )
  for (const [file, values] of Object.entries(stores))
    writeFileSync(path.join(dataDir, file), JSON.stringify(values))
}

function avatarShown(file: string): boolean {
  const png = PNG.sync.read(readFileSync(file))
  let n = 0
  for (let y = 100; y < Math.min(400, png.height); y++) {
    for (let x = 0; x < Math.min(200, png.width); x++) {
      const i = (y * png.width + x) * 4
      if (
        Math.abs(png.data[i] - AVATAR_RGB[0]) < 12 &&
        Math.abs(png.data[i + 1] - AVATAR_RGB[1]) < 12 &&
        Math.abs(png.data[i + 2] - AVATAR_RGB[2]) < 12
      )
        n++
    }
  }
  return n >= 100
}

function placeWindow(display: string, origin: Point, width: number, height: number): void {
  const proc = Bun.spawnSync(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      X11_WINDOW,
      WINDOW_TITLE,
      String(origin.x),
      String(origin.y),
      String(width),
      String(height)
    ],
    { env: { ...process.env, DISPLAY: display } }
  )
  if (proc.exitCode !== 0)
    throw new Error(`x11-window: ${proc.stderr.toString().trim().split('\n').at(-1)}`)
}

/**
 * Start the desktop app on a fresh Xvfb display with `world`'s projects, put
 * its window at `width`x`height`, wait until the rail and the frame settle,
 * run `body`, then tear everything down.
 */
export async function withTauri<T>(
  opts: { world: World; home: string; width: number; height: number; stores?: AppStores },
  body: (session: TauriSession) => Promise<T>
): Promise<T> {
  if (!existsSync(TAURI_BIN))
    throw new Error(`no desktop app at ${TAURI_BIN} (see tools/reference/tauri.ts)`)
  rmSync(opts.home, { recursive: true, force: true })
  seedDataDir(opts.home, opts.world, opts.stores)
  const xvfb = await startXvfb(opts.width + SCREEN_MARGIN, opts.height + SCREEN_MARGIN)
  const bus = await startSessionBus(xvfb.display)
  const home = opts.home
  const app = Bun.spawn([TAURI_BIN], {
    env: {
      ...process.env,
      DISPLAY: xvfb.display,
      ...(bus.address && { DBUS_SESSION_BUS_ADDRESS: bus.address }),
      HOME: home,
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_STATE_HOME: path.join(home, '.local/state')
    },
    stdout: Bun.file(path.join(home, 'app.log')),
    stderr: Bun.file(path.join(home, 'app.err.log'))
  })
  const origin = { x: SCREEN_MARGIN / 2, y: SCREEN_MARGIN / 2 }
  const shoot = (outPath: string) =>
    grabFrame(xvfb.display, opts.width, opts.height, outPath, origin)
  /**
   * Grab until two grabs a second apart match, so `ready` holds on a frame
   * the app has stopped painting. The app's text cannot be read, so this
   * stands in for the checks GPUIX waits on (a page still loading keeps its
   * spinner turning).
   */
  const settled = async (outPath: string, ready: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    let previous = ''
    for (;;) {
      if (app.exitCode !== null) throw new Error(`termul-manager exited with ${app.exitCode}`)
      await shoot(outPath)
      const frame = Bun.hash(await Bun.file(outPath).arrayBuffer()).toString()
      if (frame === previous && ready()) return true
      if (Date.now() > deadline) return false
      previous = frame
      await Bun.sleep(1000)
    }
  }
  try {
    placeWindow(xvfb.display, origin, opts.width, opts.height)
    const probe = path.join(home, 'ready.png')
    if (!(await settled(probe, () => avatarShown(probe), READY_TIMEOUT_MS)))
      throw new Error('the desktop app never painted its project rail')
    return await body({
      display: xvfb.display,
      origin,
      grab: async (outPath) => {
        if (!(await settled(outPath, () => true, SETTLE_TIMEOUT_MS)))
          console.error(`[tauri] ${outPath}: still painting after ${SETTLE_TIMEOUT_MS} ms`)
      }
    })
  } finally {
    app.kill()
    await app.exited
    bus.stop()
    xvfb.stop()
  }
}

/** GPUI keystroke syntax (`ctrl-shift-n`, `enter`) to an X keysym combination (`Control_L+Shift_L+n`). */
export function x11Keys(stroke: string): string {
  const named: Record<string, string> = {
    ctrl: 'Control_L',
    shift: 'Shift_L',
    alt: 'Alt_L',
    enter: 'Return',
    escape: 'Escape',
    tab: 'Tab',
    backspace: 'BackSpace',
    space: 'space',
    ',': 'comma',
    '=': 'equal',
    '-': 'minus'
  }
  const parts = stroke.match(/^((?:(?:ctrl|alt|shift)-)*)(.+)$/)
  const mods = (parts?.[1] ?? '').split('-').filter(Boolean)
  const key = parts?.[2] ?? stroke
  return [...mods, key].map((part) => named[part] ?? part).join('+')
}

/**
 * Actions as X input. A click goes to the point GPUIX found the same target
 * at (GPUIX runs first and records it), so the two layouts must agree for
 * the click to land: the frame shows when they do not. The app's text cannot
 * be read, so the driver has no checks; the frames are the reference.
 */
export function tauriDriver(session: TauriSession, points: Map<string, Point>): Driver {
  const at = (point: Point): [string, string] => [
    String(Math.round(session.origin.x + point.x)),
    String(Math.round(session.origin.y + point.y))
  ]
  return {
    async act(step, index, action: Action) {
      const log: ActionLog = { step, action: describe(action), via: 'none', ok: true }
      try {
        switch (action.do) {
          case 'click': {
            if (action.button || action.modifiers) throw new Error('only plain left clicks')
            const fixed = 'point' in action.target ? action.target.point : undefined
            const point = fixed ?? points.get(`${step}/${index}`)
            if (!point) throw new Error('GPUIX recorded no point for this click')
            log.via = fixed ? 'point' : 'gpuix-point'
            xinput(session.display, 'click', ...at(point))
            break
          }
          case 'press':
            log.via = 'key'
            for (const stroke of (action.gpuixKeys ?? action.keys).split(' '))
              xinput(session.display, 'key', x11Keys(stroke))
            break
          case 'type':
            log.via = 'key'
            xinput(session.display, 'type', action.text)
            break
          case 'wait':
            await Bun.sleep(action.ms)
            break
          default:
            throw new Error(`${action.do} is not driven in the desktop app`)
        }
        await Bun.sleep(250)
      } catch (error) {
        log.ok = false
        log.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
      }
      return log
    }
  }
}
