/**
 * Headless GPUIX capture on Linux: Xvfb + lavapipe + ffmpeg x11grab, the
 * recipe measured in /root/gpuix-spike/xshot.sh. `@gpuix/react/automation`
 * refuses `screenshot()` on Linux, so pixels come from the X server.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const SCREEN = { width: 1280, height: 800 } as const

export interface XvfbHandle {
  display: string
  stop: () => void
}

export async function startXvfb(): Promise<XvfbHandle> {
  const display = `:${90 + Math.floor(Math.random() * 9)}`
  const proc = Bun.spawn(['Xvfb', display, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`], {
    stdout: 'ignore',
    stderr: 'ignore'
  })
  await Bun.sleep(500)
  return { display, stop: () => proc.kill() }
}

export const gpuixEnv = (display: string): Record<string, string> => ({
  ...process.env,
  DISPLAY: display,
  VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json',
  GPUIX_BACKGROUND: '1'
})

export async function grabScreen(display: string, outPng: string): Promise<void> {
  const proc = Bun.spawn(
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
      `${SCREEN.width}x${SCREEN.height}`,
      '-i',
      display,
      '-frames:v',
      '1',
      outPng
    ],
    { stdout: 'ignore', stderr: 'inherit' }
  )
  await proc.exited
  if (proc.exitCode !== 0 || !existsSync(outPng)) throw new Error(`x11grab failed for ${outPng}`)
}

/** Runs a GPUIX entry under Xvfb until `readyFile` exists, grabs the screen, returns the ready file's JSON. */
export async function shootEntry<T>(options: {
  entry: string
  args?: string[]
  readyFile: string
  outPng: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Extra settle time after the entry signals ready, for the last paint. */
  settleMs?: number
}): Promise<T> {
  const xvfb = await startXvfb()
  const app = Bun.spawn(['bun', resolve(options.entry), ...(options.args ?? [])], {
    env: { ...gpuixEnv(xvfb.display), ...(options.env ?? {}) },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000)
    while (!existsSync(options.readyFile)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.readyFile}`)
      if (app.exitCode !== null) throw new Error(`entry exited with ${app.exitCode} before ready`)
      await Bun.sleep(100)
    }
    await Bun.sleep(options.settleMs ?? 500)
    await grabScreen(xvfb.display, options.outPng)
    return (await Bun.file(options.readyFile).json()) as T
  } finally {
    app.kill()
    xvfb.stop()
  }
}
