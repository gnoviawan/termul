/**
 * The real GPUIX client under Xvfb for the browser-pane checks. Like `withGpuix`, but the
 * client process stays in our hands: its stdout (the automation channel, plus the client's info
 * log) is copied to a file, its pid is known, and the window can be closed the way a user does.
 */

import { appendFileSync } from 'node:fs'
import { connectStdio } from '@gpuix/native/automation'
import { APP_DIR } from '../../build'
import type { TestServer } from '../parity/server'
import {
  grabFrame,
  LAVAPIPE_ICD,
  SCREEN_MARGIN,
  startXvfb,
  windowOrigin
} from '../parity/shoot-gpuix'

export type App = Awaited<ReturnType<typeof connectStdio>>

export interface Session {
  app: App
  display: string
  pid: number
  /** Resolves with the exit code once the client exits. */
  exited: Promise<number | null>
  logFile: string
  grab(outPath: string): Promise<void>
  origin(): Promise<{ x: number; y: number }>
  stop(): Promise<void>
}

export async function startSession(opts: {
  server: TestServer
  entry: string
  width: number
  height: number
  clientStateDir: string
  logFile: string
  env?: Record<string, string>
}): Promise<Session> {
  const xvfb = await startXvfb(opts.width + SCREEN_MARGIN, opts.height + SCREEN_MARGIN)
  const child = Bun.spawn(['bun', opts.entry], {
    cwd: APP_DIR,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      DISPLAY: xvfb.display,
      VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES ?? LAVAPIPE_ICD,
      GPUIX_BACKGROUND: '1',
      GPUIX_WINDOW_SIZE: `${opts.width}x${opts.height}`,
      TERMUL_SERVER_URL: opts.server.baseUrl,
      TERMUL_SERVER_TOKEN: opts.server.token,
      TERMUL_GPUIX_STATE_DIR: opts.clientStateDir,
      ...opts.env
    }
  })
  const listeners: ((text: string) => void)[] = []
  const pump = async (stream: ReadableStream<Uint8Array>, tee: boolean) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      const text = decoder.decode(value, { stream: true })
      appendFileSync(opts.logFile, text.replace(/^(id|event|data):.*\n?/gm, ''))
      if (tee) for (const listener of listeners) listener(text)
    }
  }
  void pump(child.stdout, true)
  void pump(child.stderr, false)
  const app = await connectStdio({
    write: (chunk: string) => {
      child.stdin.write(chunk)
      child.stdin.flush()
    },
    feed: (listener: (text: string) => void) => {
      listeners.push(listener)
    },
    close: async () => {
      child.kill()
    }
  })
  const origin = () => windowOrigin(xvfb.display, opts.width, opts.height)
  return {
    app,
    display: xvfb.display,
    pid: child.pid,
    exited: child.exited,
    logFile: opts.logFile,
    origin,
    grab: async (outPath) => {
      await Bun.sleep(400)
      await grabFrame(xvfb.display, opts.width, opts.height, outPath, await origin())
    },
    stop: async () => {
      if (child.exitCode === null) child.kill()
      await Promise.race([child.exited, Bun.sleep(3000)])
      xvfb.stop()
    }
  }
}
