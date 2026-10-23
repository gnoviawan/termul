/**
 * One termul-server child: spawn it, wait until it answers, classify why it
 * died, stop it. The child runs in its own session (`detached`), so a Ctrl+C
 * in the app's terminal reaches only the app, which then stops the server on
 * purpose instead of racing it. A POSIX `sh` watchdog stops the server when
 * the app dies without running its exit hooks (SIGKILL, a crash in native code).
 */

import { closeSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { dataDirArgs } from './paths'
import { isHealthy } from './probe'
import type { ServerFailure } from './status'

export interface SpawnSpec {
  binary: string
  port: number
  dataDir: string
  token: string
  logFile: string
  /** Stop the server when this pid is gone. `null` for a keep-alive server. */
  watchParentPid: number | null
}

export interface ServerChild {
  pid: number
  port: number
  /** Resolves with the exit description once the process is gone. */
  exited: Promise<string>
  isAlive(): boolean
  stop(graceMs?: number): Promise<void>
  /** Signal only; for the synchronous `exit` hook. */
  signalStop(): void
}

export type ReadyOutcome = { ok: true } | { ok: false; failure: ServerFailure; portInUse: boolean }

const STOP_GRACE_MS = 5000
const LOG_TAIL_BYTES = 4096

const WATCHDOG_SCRIPT = `parent=$1; child=$2
while kill -0 "$parent" 2>/dev/null; do
  kill -0 "$child" 2>/dev/null || exit 0
  sleep 1
done
kill -TERM "$child" 2>/dev/null
i=0
while kill -0 "$child" 2>/dev/null && [ "$i" -lt 10 ]; do sleep 1; i=$((i+1)); done
kill -KILL "$child" 2>/dev/null
exit 0`

function rotateLog(logFile: string): void {
  try {
    statSync(logFile)
    renameSync(logFile, `${logFile}.prev`)
  } catch {
    // first spawn: nothing to rotate
  }
}

export function readLogTail(logFile: string): string {
  try {
    const size = statSync(logFile).size
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const fd = openSync(logFile, 'r')
    try {
      readSync(fd, buffer, 0, length, size - length)
    } finally {
      closeSync(fd)
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
    return buffer.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '')
  } catch {
    return ''
  }
}

/** Why a server exited during startup, from the tail of its log. */
export function classifyEarlyExit(
  logTail: string,
  dataDir: string
): { failure: ServerFailure; portInUse: boolean } {
  if (/Address already in use/i.test(logTail)) {
    return { failure: { code: 'start_failed', detail: 'the port is taken' }, portInUse: true }
  }
  const locked = logTail.match(/already in use by another Termul host[^\n]*?held(?: by pid (\d+))?/)
  if (locked) {
    return {
      failure: { code: 'data_locked', dataDir, holderPid: locked[1] ? Number(locked[1]) : null },
      portInUse: false
    }
  }
  const lastLine =
    logTail
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'exited during startup'
  return { failure: { code: 'start_failed', detail: lastLine.slice(0, 300) }, portInUse: false }
}

export function spawnServer(spec: SpawnSpec): ServerChild {
  rotateLog(spec.logFile)
  const log = Bun.file(spec.logFile)
  const child = Bun.spawn(
    [
      spec.binary,
      '--host',
      '127.0.0.1',
      '--port',
      String(spec.port),
      ...dataDirArgs(process.platform, spec.dataDir)
    ],
    {
      // The token travels in the environment, never argv: the process list is
      // world-readable, /proc/<pid>/environ is owner-only.
      env: { ...process.env, TERMUL_WEB_AUTH_TOKEN: spec.token },
      stdin: 'ignore',
      stdout: log,
      stderr: log,
      detached: true
    }
  )
  const watchdog =
    spec.watchParentPid !== null && process.platform !== 'win32'
      ? Bun.spawn(
          [
            'sh',
            '-c',
            WATCHDOG_SCRIPT,
            'termul-gpuix-watchdog',
            String(spec.watchParentPid),
            String(child.pid)
          ],
          { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true }
        )
      : null
  const exited = child.exited.then(() => {
    watchdog?.kill()
    return child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`
  })
  const isAlive = (): boolean => child.exitCode === null && child.signalCode === null
  return {
    pid: child.pid,
    port: spec.port,
    exited,
    isAlive,
    signalStop() {
      if (isAlive()) child.kill('SIGTERM')
      watchdog?.kill()
    },
    async stop(graceMs = STOP_GRACE_MS) {
      if (!isAlive()) return
      child.kill('SIGTERM')
      const done = await Promise.race([
        exited.then(() => true),
        Bun.sleep(graceMs).then(() => false)
      ])
      if (!done) {
        child.kill('SIGKILL')
        await exited
      }
    }
  }
}

/** Poll `/health` until it answers, the child dies, or the deadline passes. */
export async function waitForReady(
  child: ServerChild,
  logFile: string,
  dataDir: string,
  timeoutMs: number
): Promise<ReadyOutcome> {
  const origin = `http://127.0.0.1:${child.port}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!child.isAlive()) {
      await child.exited
      return { ok: false, ...classifyEarlyExit(readLogTail(logFile), dataDir) }
    }
    if (await isHealthy(origin, 500)) return { ok: true }
    await Bun.sleep(100)
  }
  await child.stop()
  return { ok: false, failure: { code: 'start_timeout', timeoutMs }, portInUse: false }
}
