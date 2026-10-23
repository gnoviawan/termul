/**
 * Run the GPUIX client under Xvfb with the lavapipe Vulkan ICD and grab frames.
 *
 * The app is driven through `@gpuix/react/automation`'s `launch()`, which
 * waits for test ids over the stdin protocol. Its `screenshot()` is not
 * available on Linux, so frames are grabbed from the X server with ffmpeg,
 * with the pointer left out of the capture.
 */

import { existsSync } from 'node:fs'
import { launch } from '@gpuix/react/automation'
import { APP_DIR } from '../../build'
import type { TestServer } from './server'

type GpuixApp = Awaited<ReturnType<typeof launch>>

export const READY_TIMEOUT_MS = 60_000
const SETTLE_MS = 400
const LAVAPIPE_ICD = '/usr/share/vulkan/icd.d/lvp_icd.json'

function freeDisplay(): number {
  for (let n = 90; n < 200; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return n
  }
  throw new Error('no free X display between :90 and :199')
}

async function startXvfb(
  width: number,
  height: number
): Promise<{ display: string; stop(): void }> {
  const number = freeDisplay()
  const display = `:${number}`
  const child = Bun.spawn(['Xvfb', display, '-nocursor', '-screen', '0', `${width}x${height}x24`], {
    stdout: 'ignore',
    stderr: 'ignore'
  })
  const socket = `/tmp/.X11-unix/X${number}`
  const deadline = Date.now() + 5000
  while (!existsSync(socket)) {
    if (child.exitCode !== null) throw new Error(`Xvfb ${display} exited with ${child.exitCode}`)
    if (Date.now() > deadline) throw new Error(`Xvfb ${display} did not come up`)
    await Bun.sleep(50)
  }
  return { display, stop: () => child.kill() }
}

async function grabFrame(
  display: string,
  width: number,
  height: number,
  outPath: string
): Promise<void> {
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
      '-video_size',
      `${width}x${height}`,
      '-i',
      display,
      '-frames:v',
      '1',
      outPath
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  )
  const code = await ffmpeg.exited
  if (code !== 0)
    throw new Error(`ffmpeg x11grab failed: ${await new Response(ffmpeg.stderr).text()}`)
}

export interface GpuixSessionOptions {
  server: TestServer
  entry: string
  width: number
  height: number
  clientStateDir: string
}

export interface GpuixSession {
  app: GpuixApp
  /** Wait a few frames, then write the current window contents to `outPath`. */
  grab(outPath: string): Promise<void>
}

/** Start Xvfb and the client, run `body` against the live app, then tear both down. */
export async function withGpuix<T>(
  opts: GpuixSessionOptions,
  body: (session: GpuixSession) => Promise<T>
): Promise<T> {
  const xvfb = await startXvfb(opts.width, opts.height)
  try {
    const app = await launch({
      command: 'bun',
      args: [opts.entry],
      cwd: APP_DIR,
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
        GPUIX_BACKGROUND: '1',
        TERMUL_SERVER_URL: opts.server.baseUrl,
        TERMUL_SERVER_TOKEN: opts.server.token,
        TERMUL_GPUIX_STATE_DIR: opts.clientStateDir
      }
    })
    try {
      return await body({
        app,
        grab: async (outPath) => {
          await Bun.sleep(SETTLE_MS)
          await grabFrame(xvfb.display, opts.width, opts.height, outPath)
        }
      })
    } finally {
      await app.close()
    }
  } finally {
    xvfb.stop()
  }
}

export async function shootGpuix(
  opts: GpuixSessionOptions & { readyTestIds: string[]; outPath: string }
): Promise<void> {
  await withGpuix(opts, async ({ app, grab }) => {
    for (const testId of opts.readyTestIds) {
      await app.getByTestId(testId).waitFor({ timeoutMs: READY_TIMEOUT_MS })
    }
    await grab(opts.outPath)
  })
}
