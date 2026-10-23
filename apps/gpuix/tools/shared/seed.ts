/**
 * Helpers the chat and composer tools share for seeding a throwaway
 * termul-server: a free port in the units' range, the state root, and a
 * custom ACP agent stored the way the app stores one.
 */

import net from 'node:net'
import { scopedKey } from '../../../../src/shared/types/persistence.types.ts'
import type { WsClient } from './ws.ts'

const PORT_RANGE = [8190, 8199] as const

/**
 * Where a tool keeps its servers' state and its output. `GPUIX_STATE_ROOT`
 * overrides the tool's default, so a unit running it next to the unit that
 * owns the default writes under its own `/tmp/gpuix-<unit>`.
 */
export function stateRoot(fallback: string): string {
  return process.env.GPUIX_STATE_ROOT ?? fallback
}

function isPortFree(port: number): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** `requested` when it is free, else the first free port in 8190-8199. */
export async function pickPort(requested?: number): Promise<number> {
  if (requested !== undefined) {
    if (!(await isPortFree(requested))) throw new Error(`port ${requested} is taken`)
    return requested
  }
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port in ${PORT_RANGE.join('-')}`)
}

export interface AgentConfig {
  configId: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  allowTerminal: boolean
}

/**
 * Saves `config` as the device's only custom agent and its last selection, so
 * the launcher lists it and picks it. The stored copy adds `id` (equal to
 * `configId`, as the persistence migration backfills it).
 */
export async function registerAgent(
  ws: WsClient,
  deviceId: string,
  config: AgentConfig
): Promise<void> {
  const agentsKey = scopedKey('acp/agents', deviceId)
  const current = await ws.request<{ revision?: number }>('store_read', { key: agentsKey })
  await ws.request('store_write', {
    key: agentsKey,
    value: { _version: 1, data: [{ id: config.configId, ...config }] },
    baseRevision: current.revision ?? 0
  })
  await ws.request('store_write', {
    key: scopedKey('agents/last-selected', deviceId),
    value: { _version: 1, data: { mode: 'acp', agentId: config.configId } }
  })
}
