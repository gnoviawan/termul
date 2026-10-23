/**
 * The lifecycle of the app's termul-server, as one state machine published
 * through `ServerStatus`:
 *
 *   starting ──ready──► ready ──exit──► crashed ──(backoff)──► starting
 *       │                  │                │
 *       └──fail──► failed ◄┴──crash loop────┘      any ──shutdown──► stopped
 *                     │
 *                     └──retry()──► starting
 *
 * The origin the window talks to is fixed once the first start settles: the
 * browser environment is installed with it, so every restart reuses the port.
 * Only the first start may move to another port when the chosen one is taken.
 */

import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { log } from '../log'
import type { BinaryLookup } from './paths'
import type { ProbeResult } from './probe'
import type { ServerRecord } from './record'
import type { ReadyOutcome, ServerChild, SpawnSpec } from './server-process'
import {
  createStatusCell,
  describeFailure,
  type ServerFailure,
  type ServerPhase,
  type ServerStatus
} from './status'

export interface ManagedServer {
  binary: BinaryLookup
  dataDir: string
  token: string
  port: number
  logFile: string
  keepAlive: boolean
  /** A keep-alive server from an earlier launch, adopted instead of spawned. */
  existingPid: number | null
}

export interface SupervisorDeps {
  spawn(spec: SpawnSpec): ServerChild
  waitForReady(child: ServerChild, timeoutMs: number): Promise<ReadyOutcome>
  probe(origin: string, token: string): Promise<ProbeResult>
  pickPort(): Promise<number>
  isPidAlive(pid: number): boolean
  saveRecord(record: ServerRecord, token: string): void
  clearRecord(pid: number): void
  parentPid: number
  /** Defaults to `RESTART_BACKOFF_MS`. */
  restartBackoffMs?: readonly number[]
}

export const READY_TIMEOUT_MS = 30_000
/** Delay before restart N (1-based); the last entry repeats. */
export const RESTART_BACKOFF_MS = [250, 1000, 2000, 5000]
/** Crashes in a row, each within `STABLE_UPTIME_MS` of its start, before giving up. */
export const MAX_CRASHES = 5
export const STABLE_UPTIME_MS = 30_000
const PORT_ATTEMPTS = 5
const ADOPTED_POLL_MS = 1000

export interface Supervisor {
  status: ServerStatus
  origin(): string
  /** First start. Resolves once the phase is `ready` or `failed`. */
  start(): Promise<ServerPhase>
  shutdown(): Promise<void>
  /** Best effort from a synchronous `exit` hook: signal, do not wait. */
  shutdownSync(): void
}

function probeFailure(result: Exclude<ProbeResult, { kind: 'ok' }>): ServerFailure {
  switch (result.kind) {
    case 'version_mismatch':
      return { code: 'version_mismatch', expected: WS_PROTOCOL_VERSION, actual: result.actual }
    case 'unauthorized':
      return { code: 'unauthorized' }
    case 'unreachable':
      return { code: 'unreachable', detail: result.detail }
  }
}

export function createSupervisor(server: ManagedServer, deps: SupervisorDeps): Supervisor {
  let port = server.port
  let portLocked = false
  /** The server the window talks to now: our child, or a keep-alive one we adopted. */
  let current: { kind: 'child'; child: ServerChild } | { kind: 'adopted'; pid: number } | null =
    null
  let adoptedTimer: ReturnType<typeof setInterval> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let crashes = 0
  let startedAt = 0
  let stopping = false
  let firstStart: Promise<ServerPhase> | null = null
  const currentPid = (): number | null =>
    current === null ? null : current.kind === 'child' ? current.child.pid : current.pid

  const { status, set } = createStatusCell({ kind: 'starting', attempt: 1, after: null }, () => {
    crashes = 0
    log.info('launcher', 'retry requested')
    void startOnce()
  })
  const originOf = (p: number): string => `http://127.0.0.1:${p}`

  const fail = (failure: ServerFailure): ServerPhase => {
    log.error('launcher', `server failed (${failure.code}): ${describeFailure(failure)}`)
    const phase: ServerPhase = { kind: 'failed', failure }
    set(phase)
    return phase
  }

  const onExit = (pid: number, detail: string): void => {
    if (currentPid() !== pid) return
    current = null
    if (stopping) return
    const uptime = Date.now() - startedAt
    if (uptime >= STABLE_UPTIME_MS) crashes = 0
    crashes += 1
    if (crashes >= MAX_CRASHES) {
      fail({ code: 'crash_loop', crashes })
      return
    }
    const backoff = deps.restartBackoffMs ?? RESTART_BACKOFF_MS
    const restartInMs = backoff[Math.min(crashes, backoff.length) - 1]
    log.warn(
      'launcher',
      `server pid ${pid} crashed (${detail}) after ${uptime} ms; restart ${crashes} in ${restartInMs} ms`
    )
    set({ kind: 'crashed', detail, restartInMs, attempt: crashes })
    restartTimer = setTimeout(() => {
      restartTimer = null
      void startOnce(detail)
    }, restartInMs)
  }

  const watchAdopted = (pid: number): void => {
    adoptedTimer = setInterval(() => {
      if (deps.isPidAlive(pid)) return
      if (adoptedTimer) clearInterval(adoptedTimer)
      adoptedTimer = null
      onExit(pid, 'adopted server exited')
    }, ADOPTED_POLL_MS)
  }

  const adopt = async (pid: number): Promise<ServerPhase | null> => {
    const result = await deps.probe(originOf(port), server.token)
    if (result.kind !== 'ok') {
      log.warn(
        'launcher',
        `recorded server pid ${pid} on port ${port} not usable (${result.kind}); spawning`
      )
      return null
    }
    log.info(
      'launcher',
      `reusing server pid ${pid} on port ${port} (protocol ${result.protocolVersion})`
    )
    current = { kind: 'adopted', pid }
    startedAt = Date.now()
    watchAdopted(pid)
    const phase: ServerPhase = { kind: 'ready', origin: 'reused', pid }
    set(phase)
    return phase
  }

  const startOnce = async (after: string | null = null): Promise<ServerPhase> => {
    if (stopping) return status.get()
    const attempt = crashes + 1
    set({ kind: 'starting', attempt, after })
    if (!server.binary.found)
      return fail({ code: 'binary_not_found', searched: server.binary.searched })
    for (let tries = 1; ; tries++) {
      log.info('launcher', `spawning ${server.binary.path} on port ${port} (attempt ${attempt})`)
      const spawned = deps.spawn({
        binary: server.binary.path,
        port,
        dataDir: server.dataDir,
        token: server.token,
        logFile: server.logFile,
        watchParentPid: server.keepAlive ? null : deps.parentPid
      })
      current = { kind: 'child', child: spawned }
      startedAt = Date.now()
      const ready = await deps.waitForReady(spawned, READY_TIMEOUT_MS)
      if (!ready.ok) {
        current = null
        if (ready.portInUse && !portLocked && tries < PORT_ATTEMPTS) {
          log.warn('launcher', `port ${port} is taken; picking another`)
          port = await deps.pickPort()
          continue
        }
        return fail(
          ready.portInUse
            ? { code: 'start_failed', detail: `port ${port} is taken` }
            : ready.failure
        )
      }
      const probed = await deps.probe(originOf(port), server.token)
      if (probed.kind !== 'ok' || !spawned.isAlive()) {
        await spawned.stop()
        current = null
        return fail(
          probed.kind === 'ok'
            ? { code: 'start_failed', detail: 'exited after ready' }
            : probeFailure(probed)
        )
      }
      void spawned.exited.then((detail) => onExit(spawned.pid, detail))
      deps.saveRecord(
        {
          pid: spawned.pid,
          port,
          protocolVersion: probed.protocolVersion,
          dataDir: server.dataDir,
          binary: server.binary.path,
          keepAlive: server.keepAlive,
          startedAt: new Date().toISOString()
        },
        server.token
      )
      log.info(
        'launcher',
        `server pid ${spawned.pid} ready on port ${port} in ${Date.now() - startedAt} ms (protocol ${probed.protocolVersion})`
      )
      const phase: ServerPhase = { kind: 'ready', origin: 'spawned', pid: spawned.pid }
      set(phase)
      return phase
    }
  }

  return {
    status,
    origin: () => originOf(port),
    start() {
      firstStart ??= (async () => {
        const adopted = server.existingPid !== null ? await adopt(server.existingPid) : null
        const phase = adopted ?? (await startOnce())
        portLocked = true
        return phase
      })()
      return firstStart
    },
    async shutdown() {
      stopping = true
      if (restartTimer) clearTimeout(restartTimer)
      if (adoptedTimer) clearInterval(adoptedTimer)
      const running = current
      current = null
      if (running?.kind === 'child' && running.child.isAlive() && !server.keepAlive) {
        log.info('launcher', `stopping server pid ${running.child.pid}`)
        await running.child.stop()
        deps.clearRecord(running.child.pid)
        log.info('launcher', `server pid ${running.child.pid} stopped`)
      } else if (running) {
        const pid = running.kind === 'child' ? running.child.pid : running.pid
        log.info(
          'launcher',
          `leaving server pid ${pid} running (${running.kind === 'adopted' ? 'reused' : 'keep-alive'})`
        )
      }
      set({ kind: 'stopped' })
    },
    shutdownSync() {
      if (stopping) return
      stopping = true
      const running = current
      if (running?.kind === 'child' && running.child.isAlive() && !server.keepAlive) {
        running.child.signalStop()
        deps.clearRecord(running.child.pid)
        log.info('launcher', `exit: sent SIGTERM to server pid ${running.child.pid}`)
      }
    }
  }
}
