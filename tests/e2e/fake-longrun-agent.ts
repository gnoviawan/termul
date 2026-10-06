/**
 * Fake ACP agent for E2E: streams `agent_message_chunk` session updates at a
 * fixed rate for DURATION_SEC (default 300), then completes the prompt with
 * `stopReason: 'end_turn'`. Deterministic, no network, no LLM.
 *
 * Wire behavior mirrors what termul-server's ACP client sends:
 * - `initialize` → advertise `loadSession` (persistent) so reopen flows work.
 * - `session/new` → mint a fresh session id (server registers it).
 * - `session/prompt` → hold the request open, stream chunks, reply once done.
 *   Multiple sessions can run CONCURRENT turns (each with its own timer
 *   state) — a real agent multiplexes sessions the same way.
 * - `session/cancel` → finish the session's in-flight prompt as cancelled.
 *
 * Env knobs:
 * - DURATION_SEC (default 300): turn length.
 * - RATE (default 1): chunks per second per session.
 * - CHUNK_CHARS (default 200): text length per chunk.
 * - WIRE_LOG: optional file to append every inbound line (debugging).
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
interface JsonRpcMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: JsonValue
}

const DURATION_SEC = Number(process.env.DURATION_SEC ?? 300)
const RATE = Number(process.env.RATE ?? 1)
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 200)

const write = (line: string): void => {
  process.stdout.write(`${line}\n`)
}
const notify = (method: string, params: JsonValue): void => {
  write(JSON.stringify({ jsonrpc: '2.0', method, params }))
}
const respond = (id: number | string | undefined, result: JsonValue): void => {
  write(JSON.stringify({ jsonrpc: '2.0', id, result }))
}
const respondError = (id: number | string | undefined, code: number, message: string): void => {
  write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}

interface InFlight {
  id: number | string
  sessionId: string
  startedAt: number
  chunks: number
}

/** Per-session in-flight turns — concurrent sessions stream simultaneously. */
const inFlightBySession = new Map<string, InFlight>()

function tick(): void {
  for (const inFlight of inFlightBySession.values()) {
    const elapsed = (Date.now() - inFlight.startedAt) / 1000
    if (elapsed >= DURATION_SEC) {
      notify('session/update', {
        sessionId: inFlight.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `[DONE after ${inFlight.chunks} chunks over ${Math.round(elapsed)}s]`
          }
        }
      })
      respond(inFlight.id, { stopReason: 'end_turn' })
      inFlightBySession.delete(inFlight.sessionId)
      continue
    }
    inFlight.chunks++
    const idx = inFlight.chunks
    notify('session/update', {
      sessionId: inFlight.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `${`chunk-${idx} `.repeat(Math.max(1, Math.floor(CHUNK_CHARS / 10)))}t=${Math.round(elapsed)}s`
        }
      }
    })
  }
}

setInterval(tick, Math.max(100, Math.floor(1000 / RATE)))

function handle(msg: JsonRpcMessage): void {
  const { id, method, params } = msg
  const p = (params ?? {}) as Record<string, JsonValue>
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: 'persistent', promptCapabilities: {} },
        authMethods: []
      })
      break
    case 'newSession':
    case 'session/new': {
      const sid = `sess-${Math.random().toString(36).slice(2, 10)}`
      respond(id, { sessionId: sid, modes: [], models: [] })
      break
    }
    case 'prompt':
    case 'session/prompt': {
      const sessionId = String(p.sessionId ?? 'unknown')
      if (inFlightBySession.has(sessionId)) {
        respondError(id, -32000, 'turn already in progress for this session')
        return
      }
      inFlightBySession.set(sessionId, { id: id!, sessionId, startedAt: Date.now(), chunks: 0 })
      break
    }
    case 'cancel':
    case 'session/cancel': {
      const sessionId = String(p.sessionId ?? 'unknown')
      const inFlight = inFlightBySession.get(sessionId)
      if (inFlight) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `[CANCELLED after ${inFlight.chunks} chunks]` }
          }
        })
        respond(inFlight.id, { stopReason: 'cancelled' })
        inFlightBySession.delete(sessionId)
      }
      respond(id, { stopReason: 'cancelled' })
      break
    }
    default:
      respond(id, {})
  }
}

process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (d: string) => {
  buf += d
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      if (process.env.WIRE_LOG) {
        process.stderr.write(`IN: ${line}\n`)
      }
      handle(JSON.parse(line))
    } catch {
      /* ignore malformed */
    }
  }
})
