/**
 * Runs a bundled terminal entry under Xvfb + lavapipe (P0's `startXvfb`) until
 * it writes its ready file, then grabs the X screen. GPUI bounds are window
 * relative and Xvfb has no window manager, so the window sits at the origin.
 */
import { existsSync, unlinkSync } from 'node:fs'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../../src/window'
import { grabFrame, LAVAPIPE_ICD, startXvfb } from '../parity/shoot-gpuix'
import { type TerminalEntry, terminalEntry } from './bundle'

export const gpuixEnv = (display: string): Record<string, string | undefined> => ({
  ...process.env,
  DISPLAY: display,
  VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
  GPUIX_BACKGROUND: '1'
})

/** Runs `entry` until `readyFile` exists, optionally grabs the screen, returns the ready file's JSON. */
export async function runEntry<T>(options: {
  entry: TerminalEntry
  args?: string[]
  readyFile: string
  outPng?: string
  timeoutMs?: number
  /** Extra time after the entry signals ready, for the last paint. */
  settleMs?: number
}): Promise<T> {
  if (existsSync(options.readyFile)) unlinkSync(options.readyFile)
  const script = await terminalEntry(options.entry)
  const xvfb = await startXvfb(WINDOW_WIDTH, WINDOW_HEIGHT)
  const app = Bun.spawn(['bun', script, ...(options.args ?? [])], {
    env: gpuixEnv(xvfb.display),
    stdout: 'inherit',
    stderr: 'inherit'
  })
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    while (!existsSync(options.readyFile)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.readyFile}`)
      if (app.exitCode !== null) throw new Error(`${options.entry} exited ${app.exitCode} early`)
      await Bun.sleep(50)
    }
    await Bun.sleep(options.settleMs ?? 100)
    if (options.outPng) {
      await grabFrame(xvfb.display, WINDOW_WIDTH, WINDOW_HEIGHT, options.outPng)
    }
    return (await Bun.file(options.readyFile).json()) as T
  } finally {
    app.kill()
    await app.exited
    xvfb.stop()
  }
}
