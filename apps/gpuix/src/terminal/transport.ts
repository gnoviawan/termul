/**
 * Termul's own `/terminal/ws` client. `web-terminal-api.ts` builds its
 * singleton at import time from `window.location`, so it is imported
 * dynamically, after the environment seam is installed for the server.
 */
import type { TerminalApi, TerminalSpawnOptions } from '@shared/types/ipc.types'
import type { ClientConfig } from '../client-config'
import { installBrowserEnv } from '../env'
import { log } from '../log'
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../window'

export type { TerminalApi }

let loading: Promise<TerminalApi> | null = null

export function loadTerminalApi(config: ClientConfig): Promise<TerminalApi> {
  if (loading) return loading
  installBrowserEnv(config, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT })
  loading = (async () => {
    const [{ setWebAuthToken }, { createWebTerminalApi }] = await Promise.all([
      import('@/lib/web-auth-token'),
      import('@/lib/web-terminal-api')
    ])
    if (config.token) setWebAuthToken(config.token)
    log.info(
      'terminal',
      `transport.loaded ${JSON.stringify({ origin: config.serverUrl.origin, gated: !!config.token })}`
    )
    return createWebTerminalApi()
  })()
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
  api: TerminalApi,
  options: SpawnSessionOptions
): Promise<TerminalSession> {
  const { onData, onExit, ...spawnOptions } = options
  const result = await api.spawn(spawnOptions)
  if (!result.success) {
    log.error(
      'terminal',
      `spawn.failed ${JSON.stringify({ code: result.code, error: result.error })}`
    )
    throw new Error(`spawn failed: ${result.code} ${result.error}`)
  }
  const id = result.data.id
  const offData = api.onData((terminalId, bytes) => {
    if (terminalId === id) onData(bytes)
  })
  const offExit = api.onExit((terminalId, code) => {
    if (terminalId === id) onExit?.(code)
  })
  log.info(
    'terminal',
    `spawn.ok ${JSON.stringify({ cols: result.data.cols, rows: result.data.rows })}`
  )
  const report =
    (what: string) => (outcome: { success: boolean; code?: string; error?: string }) => {
      if (!outcome.success)
        log.warn(
          'terminal',
          `${what}.refused ${JSON.stringify({ code: outcome.code, error: outcome.error })}`
        )
    }
  return {
    id,
    cols: result.data.cols,
    rows: result.data.rows,
    write: (data) => void api.write(id, data).then(report('write')),
    resize: (cols, rows) => void api.resize(id, cols, rows).then(report('resize')),
    kill: async () => {
      report('kill')(await api.kill(id))
    },
    dispose: () => {
      offData()
      offExit()
    }
  }
}
