/**
 * Ask a termul-server whether this client can use it: `/health` for
 * liveness, then the `/ws` `authenticate` handshake, which is where the
 * server enforces the protocol version and the token
 * (`src-tauri/src/web/ws/mod.rs`, `WsErrorCode::ProtocolVersionMismatch`).
 */

import { WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'

export type ProbeResult =
  | { kind: 'ok'; protocolVersion: number }
  | { kind: 'version_mismatch'; actual: number | null }
  | { kind: 'unauthorized' }
  | { kind: 'unreachable'; detail: string }

const PROBE_TIMEOUT_MS = 3000
const PROBE_DEVICE_ID = 'termul-gpuix-launcher'

export async function isHealthy(origin: string, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

interface AuthReply {
  id?: string
  ok?: boolean
  payload?: { protocolVersion?: unknown }
  err?: { code?: string; message?: string }
}

/** The server names its own version in the refusal ("this host speaks version 7"). */
export function parseHostVersion(message: string | undefined): number | null {
  const match = message?.match(/speaks version (\d+)/)
  return match ? Number(match[1]) : null
}

export function classifyAuthReply(reply: AuthReply): ProbeResult {
  if (reply.ok === true) {
    const version = reply.payload?.protocolVersion
    return typeof version === 'number' && version === WS_PROTOCOL_VERSION
      ? { kind: 'ok', protocolVersion: version }
      : { kind: 'version_mismatch', actual: typeof version === 'number' ? version : null }
  }
  if (reply.err?.code === 'protocol_version_mismatch') {
    return { kind: 'version_mismatch', actual: parseHostVersion(reply.err.message) }
  }
  if (reply.err?.code === 'unauthorized') return { kind: 'unauthorized' }
  return { kind: 'unreachable', detail: reply.err?.message ?? 'authenticate refused' }
}

export function probeServer(origin: string, token: string | null): Promise<ProbeResult> {
  const url = `${origin.replace(/^http/, 'ws')}/ws`
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({ kind: 'unreachable', detail: `no authenticate reply in ${PROBE_TIMEOUT_MS} ms` }),
      PROBE_TIMEOUT_MS
    )
    ws.onopen = () => {
      const payload: Record<string, unknown> = {
        protocolVersion: WS_PROTOCOL_VERSION,
        deviceId: PROBE_DEVICE_ID,
        clientInstanceId: `launcher-${process.pid}`
      }
      if (token) payload.token = token
      ws.send(JSON.stringify({ id: 'launcher-probe', type: 'authenticate', payload }))
    }
    ws.onmessage = (event) => {
      let reply: AuthReply
      try {
        reply = JSON.parse(String(event.data)) as AuthReply
      } catch {
        return
      }
      if (reply.id === 'launcher-probe') finish(classifyAuthReply(reply))
    }
    ws.onerror = () => finish({ kind: 'unreachable', detail: `cannot open ${url}` })
    ws.onclose = () => finish({ kind: 'unreachable', detail: `${url} closed before authenticate` })
  })
}
