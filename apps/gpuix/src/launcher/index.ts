/**
 * The app's side of the standalone server: find or start the termul-server
 * this window talks to, keep it alive, and stop it when the app quits.
 *
 * - `TERMUL_SERVER_URL` set: attach to that server. Never spawned or stopped.
 * - A keep-alive server recorded by an earlier launch and still answering:
 *   reuse it and leave it running.
 * - Otherwise spawn one on a loopback port with a fresh token, stop it on
 *   quit, and let a watchdog stop it if the app dies without quitting.
 *
 * A second launch for the same client state dir asks the first to focus its
 * window and exits before any of this runs.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import type { ClientConfig } from '../client-config'
import { readClientConfig } from '../env/config'
import { log } from '../log'
import { hostLocalTokenFile } from './host-local'
import { claimInstance, instanceAddress } from './instance'
import { type HostFacts, launcherDir, resolveServerBinary, serverDataDir } from './paths'
import { probeServer } from './probe'
import { clearServerRecord, isPidAlive, readServerRecord, writeServerRecord } from './record'
import { spawnServer, waitForReady } from './server-process'
import { createStatusCell, describeFailure, type ServerStatus } from './status'
import { createSupervisor } from './supervisor'

export type Launch =
  | { kind: 'secondary' }
  | {
      kind: 'primary'
      config: ClientConfig
      status: ServerStatus
      onFocusRequest(listener: () => void): void
    }

const LAST_PORT_FILE = 'last-port'

function hostFacts(env: NodeJS.ProcessEnv): HostFacts {
  return {
    env,
    platform: process.platform,
    homedir: os.homedir(),
    isFile: (candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    }
  }
}

/** Beside a compiled executable, and beside the bundle (`dist/main.js`). */
function bundledDirs(): string[] {
  const dirs = [path.dirname(Bun.main)]
  const exe = path.basename(process.execPath).toLowerCase()
  if (!exe.startsWith('bun')) dirs.unshift(path.dirname(process.execPath))
  return dirs
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      )
    })
  })
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/**
 * The client keeps its web storage (device id, store partition) per server
 * origin, so the port is kept across launches: the last one when free, else
 * a fresh one. `TERMUL_GPUIX_SERVER_PORT` pins it.
 */
async function choosePort(dir: string, env: NodeJS.ProcessEnv): Promise<number> {
  const pinned = Number(env.TERMUL_GPUIX_SERVER_PORT)
  if (Number.isInteger(pinned) && pinned > 0) return pinned
  const lastFile = path.join(dir, LAST_PORT_FILE)
  const last = existsSync(lastFile) ? Number(readFileSync(lastFile, 'utf8').trim()) : Number.NaN
  const port =
    Number.isInteger(last) && last > 0 && (await isPortFree(last)) ? last : await freePort()
  writeFileSync(lastFile, `${port}\n`)
  return port
}

function installExitHooks(shutdown: () => Promise<void>, shutdownSync: () => void): void {
  process.on('exit', shutdownSync)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ] as const) {
    process.on(signal, () => {
      log.info('launcher', `${signal}: shutting down`)
      void shutdown().finally(() => process.exit(code))
    })
  }
}

async function attach(
  env: NodeJS.ProcessEnv
): Promise<{ config: ClientConfig; status: ServerStatus }> {
  const config = readClientConfig(env)
  const origin = config.serverUrl.origin
  const result = await probeServer(origin, config.token)
  const { status, set } = createStatusCell({ kind: 'starting', attempt: 1, after: null }, () => {})
  if (result.kind === 'version_mismatch') {
    const failure = {
      code: 'version_mismatch',
      expected: WS_PROTOCOL_VERSION,
      actual: result.actual
    } as const
    log.error('launcher', `attached server ${origin}: ${describeFailure(failure)}`)
    set({ kind: 'failed', failure })
  } else {
    // Unauthorized and unreachable stay with the renderer: its auth gate and
    // reconnect loop already present them.
    log.info('launcher', `attached to ${origin} (probe: ${result.kind})`)
    set({ kind: 'ready', origin: 'attached', pid: null })
  }
  return { config, status }
}

export async function launch(env: NodeJS.ProcessEnv = process.env): Promise<Launch> {
  const base = readClientConfig(env)
  const dir = launcherDir(base.stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const address = instanceAddress(base.stateDir, process.platform, dir)
  const claim = await claimInstance(address, process.platform === 'darwin')
  if (claim.kind === 'secondary') {
    log.info('launcher', 'another window is open for this state dir; asked it to focus')
    return { kind: 'secondary' }
  }

  if (env.TERMUL_SERVER_URL?.trim()) {
    const { config, status } = await attach(env)
    process.on('exit', claim.release)
    return { kind: 'primary', config, status, onFocusRequest: claim.onFocusRequest }
  }

  const host = hostFacts(env)
  const dataDir = serverDataDir(host)
  const keepAlive = env.TERMUL_GPUIX_KEEP_SERVER === '1'
  const stored = readServerRecord(dir)
  const reusable =
    stored && stored.record.dataDir === dataDir && isPidAlive(stored.record.pid) ? stored : null
  if (stored && !reusable) {
    log.info('launcher', `dropping stale server record (pid ${stored.record.pid})`)
    clearServerRecord(dir, stored.record.pid)
  }
  const token = reusable?.token ?? randomBytes(32).toString('base64url')
  const port = reusable?.record.port ?? (await choosePort(dir, env))
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const supervisor = createSupervisor(
    {
      binary: resolveServerBinary(host, bundledDirs()),
      dataDir,
      token,
      port,
      logFile: path.join(dir, 'server.log'),
      keepAlive,
      existingPid: reusable?.record.pid ?? null
    },
    {
      spawn: spawnServer,
      waitForReady: (child, timeoutMs) =>
        waitForReady(child, path.join(dir, 'server.log'), dataDir, timeoutMs),
      probe: probeServer,
      pickPort: freePort,
      isPidAlive,
      saveRecord: (record, recordToken) => writeServerRecord(dir, { record, token: recordToken }),
      clearRecord: (pid) => clearServerRecord(dir, pid),
      parentPid: process.pid
    }
  )
  log.info('launcher', `data dir ${dataDir}${keepAlive ? ', keep-alive' : ''}`)
  installExitHooks(
    async () => {
      await supervisor.shutdown()
      claim.release()
    },
    () => {
      supervisor.shutdownSync()
      claim.release()
    }
  )
  await supervisor.start()

  const config = {
    ...readClientConfig({
      ...env,
      TERMUL_SERVER_URL: supervisor.origin(),
      TERMUL_SERVER_TOKEN: token
    }),
    hostLocalTokenFile: hostLocalTokenFile(dataDir)
  }
  return {
    kind: 'primary',
    config,
    status: supervisor.status,
    onFocusRequest: claim.onFocusRequest
  }
}
