/** The X server a click-loss run uses, and the wait for a quiet host before a batch. */

import { existsSync } from 'node:fs'

export interface XServer {
  display: string
  stop(): void
}

function freeDisplay(): number {
  for (let n = 120; n < 200; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n
  }
  throw new Error('no free X display in 120-199')
}

/** Xvfb on a free display, with `extra` server arguments (e.g. `+extension XInputExtension`). */
export async function startX(width: number, height: number, extra: string[] = []): Promise<XServer> {
  const number = freeDisplay()
  const display = `:${number}`
  const child = Bun.spawn(['Xvfb', display, '-nocursor', '-screen', '0', `${width}x${height}x24`, ...extra], {
    stdout: 'ignore',
    stderr: 'ignore'
  })
  const deadline = Date.now() + 5000
  while (!existsSync(`/tmp/.X11-unix/X${number}`)) {
    if (child.exitCode !== null) throw new Error(`Xvfb ${display} exited with ${child.exitCode}`)
    if (Date.now() > deadline) throw new Error(`Xvfb ${display} did not come up`)
    await Bun.sleep(50)
  }
  return { display, stop: () => child.kill() }
}

const PERF_RUN = /^bun (run perf|tools\/perf\/run\.ts)/

function perfRunning(): boolean {
  const out = Bun.spawnSync(['ps', '-eo', 'args=']).stdout.toString()
  return out.split('\n').some((line) => PERF_RUN.test(line.trim()))
}

/** Block until no sibling perf run (`tools/perf/run.ts`) is going: it needs a quiet host. */
export async function waitForQuietHost(): Promise<void> {
  let announced = false
  while (perfRunning()) {
    if (!announced) console.error('[clickloss] a perf run is going; waiting for it to finish')
    announced = true
    await Bun.sleep(5_000)
  }
}
