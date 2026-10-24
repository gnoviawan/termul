/**
 * What the browser-pane checks read outside the app: X window state (xwininfo), real X input
 * (XTest through `xinput.py`), the helper's process tree and its memory (`/proc`).
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function xinput(display: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    [
      'uv',
      'run',
      '--quiet',
      '--with',
      'python-xlib==0.33',
      'python',
      '-I',
      path.join(import.meta.dir, 'xinput.py'),
      ...args
    ],
    { env: { ...process.env, DISPLAY: display } }
  )
  if (proc.exitCode !== 0) throw new Error(`xinput ${args.join(' ')}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

/** Direct children of `parent` with their geometry relative to it (xwininfo -children). */
export function childWindows(display: string, parent: string): { id: string; rect: Rect }[] {
  const out = Bun.spawnSync([
    'xwininfo',
    '-display',
    display,
    '-children',
    '-id',
    parent
  ]).stdout.toString()
  const found: { id: string; rect: Rect }[] = []
  for (const match of out.matchAll(/^\s+(0x[0-9a-f]+) .*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/gm)) {
    found.push({
      id: match[1],
      rect: {
        width: Number(match[2]),
        height: Number(match[3]),
        x: Number(match[4]),
        y: Number(match[5])
      }
    })
  }
  return found
}

export function mapState(display: string, window: string): string {
  const out = Bun.spawnSync(['xwininfo', '-display', display, '-id', window]).stdout.toString()
  return /Map State: (\w+)/.exec(out)?.[1] ?? 'gone'
}

function parentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  } catch {
    return null
  }
}

export function commOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return null
  }
}

/** Every live process below `root`. */
export function descendants(root: number): number[] {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry)
    if (!Number.isInteger(pid)) continue
    const parent = parentOf(pid)
    if (parent !== null) parents.set(pid, parent)
  }
  const out: number[] = []
  const walk = (pid: number) => {
    for (const [child, parent] of parents) {
      if (parent === pid) {
        out.push(child)
        walk(child)
      }
    }
  }
  walk(root)
  return out
}

export function alive(pid: number): boolean {
  const state = (() => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
    } catch {
      return null
    }
  })()
  return state !== null && state !== 'Z'
}

/** Proportional set size in MB (`/proc/<pid>/smaps_rollup`). */
export function pssMb(pid: number): number {
  try {
    const kb = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1]
    return kb ? Math.round(Number(kb) / 102.4) / 10 : 0
  } catch {
    return 0
  }
}

export function processTable(
  pids: number[]
): { pid: number; comm: string | null; pssMb: number }[] {
  return pids.map((pid) => ({ pid, comm: commOf(pid), pssMb: pssMb(pid) }))
}

/** Send WM_DELETE_WINDOW to the top-level window, as a window manager's close button does. */
export function closeWindow(display: string, window: string): string {
  const script = `
import sys
from Xlib import X, display, protocol
d = display.Display()
w = d.create_resource_object('window', int(sys.argv[1], 16))
protos = d.intern_atom('WM_PROTOCOLS')
delete = d.intern_atom('WM_DELETE_WINDOW')
supported = [d.get_atom_name(a) for a in (w.get_wm_protocols() or [])]
ev = protocol.event.ClientMessage(window=w, client_type=protos, data=(32, [delete, X.CurrentTime, 0, 0, 0]))
w.send_event(ev, event_mask=X.NoEventMask)
d.sync()
print(','.join(supported))
`
  const proc = Bun.spawnSync(
    ['uv', 'run', '--quiet', '--with', 'python-xlib==0.33', 'python', '-I', '-c', script, window],
    { env: { ...process.env, DISPLAY: display } }
  )
  if (proc.exitCode !== 0) throw new Error(`close window: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

export function stats(values: number[]): { n: number; p50: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0
  }
}

/** RGB of the window-relative pixel in a frame grabbed by the session. */
export function pixelAt(file: string, x: number, y: number): [number, number, number] {
  const png = PNG.sync.read(readFileSync(file))
  const i = (png.width * Math.round(y) + Math.round(x)) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
}

/** The page background of `pages.ts` (#1f6f43), give or take rounding. */
export function isPageGreen([r, g, b]: [number, number, number]): boolean {
  return Math.abs(r - 0x1f) < 12 && Math.abs(g - 0x6f) < 12 && Math.abs(b - 0x43) < 12
}

/** Record a one-pixel-high strip of the screen as numbered PNGs until `stop()`. */
export function recordStrip(
  display: string,
  at: { x: number; y: number; width: number },
  fps: number,
  dir: string
): { stop(): Promise<void> } {
  const ffmpeg = Bun.spawn(
    [
      'ffmpeg',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'x11grab',
      '-draw_mouse',
      '0',
      '-framerate',
      String(fps)
    ].concat([
      '-video_size',
      `${at.width}x1`,
      '-i',
      `${display}+${at.x},${at.y}`,
      path.join(dir, '%05d.png')
    ]),
    { stdout: 'ignore', stderr: 'ignore', stdin: 'pipe' }
  )
  return {
    stop: async () => {
      ffmpeg.stdin.write('q')
      ffmpeg.stdin.end()
      await Promise.race([ffmpeg.exited, Bun.sleep(3000).then(() => ffmpeg.kill())])
    }
  }
}

/**
 * Per recorded frame: where GPUIX painted the pane divider (its 1px border colour) and where the
 * webview's page starts (the page green), both relative to the strip. A frame where the page does
 * not start right after the divider shows the webview out of step with GPUIX.
 */
export function stripFrames(
  dir: string,
  border: [number, number, number]
): { divider: number | null; page: number | null }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => {
      const png = PNG.sync.read(readFileSync(path.join(dir, name)))
      let divider: number | null = null
      let page: number | null = null
      const at = (x: number): [number, number, number] => [
        png.data[x * 4],
        png.data[x * 4 + 1],
        png.data[x * 4 + 2]
      ]
      for (let x = 0; x < png.width && page === null; x++) if (isPageGreen(at(x))) page = x
      // The divider is the last border-coloured pixel left of the page (the gap between is the slot).
      for (let x = (page ?? png.width) - 1; x >= 0 && divider === null; x--) {
        if (at(x).every((v, i) => Math.abs(v - border[i]) <= 2)) divider = x
      }
      return { divider, page }
    })
}
