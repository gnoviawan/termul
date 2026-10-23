/**
 * Termul's own `/terminal/ws` client, loaded after the DOM seam is in place.
 * `web-terminal-api.ts` builds its singleton at import time from
 * `window.location`, so the import has to be dynamic and ordered after
 * `installTerminalEnv`.
 */
import type { TerminalApi, TerminalSpawnOptions } from '@shared/types/ipc.types'
import { installTerminalEnv, type TerminalEnvOptions } from './env'
import { terminalLog } from './log'

export type { TerminalApi }

export interface TerminalTransport {
  api: TerminalApi
  /** The deferred `web-terminal-api` module for the status helpers. */
  module: typeof import('@/lib/web-terminal-api')
}

let loading: Promise<TerminalTransport> | null = null

export function loadTerminalTransport(options: TerminalEnvOptions): Promise<TerminalTransport> {
  if (loading) return loading
  installTerminalEnv(options)
  loading = import('@/lib/web-terminal-api').then((module) => {
    terminalLog('info', 'transport.loaded', { origin: options.origin, gated: !!options.token })
    return { api: module.createWebTerminalApi(), module }
  })
  return loading
}

/** A spawned shell plus the subscription that feeds its output to `onData`. */
export interface TerminalSession {
  id: string
  cols: number
  rows: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => Promise<void>
  dispose: () => void
}

export interface SpawnSessionOptions extends TerminalSpawnOptions {
  projectId: string
  onData: (bytes: Uint8Array) => void
  onExit?: (code: number) => void
}

export async function spawnSession(
  transport: TerminalTransport,
  options: SpawnSessionOptions
): Promise<TerminalSession> {
  const { onData, onExit, ...spawnOptions } = options
  const result = await transport.api.spawn(spawnOptions)
  if (!result.success) {
    terminalLog('error', 'spawn.failed', { code: result.code, error: result.error })
    throw new Error(`spawn failed: ${result.code} ${result.error}`)
  }
  const id = result.data.id
  const offData = transport.api.onData((terminalId, bytes) => {
    if (terminalId === id) onData(bytes)
  })
  const offExit = transport.api.onExit((terminalId, code) => {
    if (terminalId === id) onExit?.(code)
  })
  terminalLog('info', 'spawn.ok', { cols: result.data.cols, rows: result.data.rows })
  const report =
    (what: string) => (outcome: { success: boolean; code?: string; error?: string }) => {
      if (!outcome.success)
        terminalLog('warn', `${what}.refused`, { code: outcome.code, error: outcome.error })
    }
  return {
    id,
    cols: result.data.cols,
    rows: result.data.rows,
    write: (data) => void transport.api.write(id, data).then(report('write')),
    resize: (cols, rows) => void transport.api.resize(id, cols, rows).then(report('resize')),
    kill: async () => {
      report('kill')(await transport.api.kill(id))
    },
    dispose: () => {
      offData()
      offExit()
    }
  }
}
