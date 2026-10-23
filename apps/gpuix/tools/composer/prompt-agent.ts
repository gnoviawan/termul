/**
 * ACP stdio agent for the composer checks: every `session/prompt` is appended
 * to `$COMPOSER_PROMPT_LOG` as one JSON line holding the exact content blocks
 * it received, then the turn ends with a one-word reply. The first prompt of a
 * session also advertises one slash command (`compact`) for the slash menu.
 */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.COMPOSER_PROMPT_LOG

type Id = number | string
interface Incoming {
  id?: Id
  method?: string
  params?: { sessionId?: string; prompt?: unknown[] }
}

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

let counter = 0
const advertised = new Set<string>()

function advertiseCommands(sessionId: string): void {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compact the conversation', input: null }
        ]
      }
    }
  })
}

function handle({ id, method, params }: Incoming): void {
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, embeddedContext: true }
        },
        authMethods: []
      }
    })
  } else if (method === 'session/new') {
    const sessionId = `composer-${process.pid}-${++counter}`
    send({ id, result: { sessionId } })
  } else if (method === 'session/prompt' && id !== undefined) {
    const sessionId = params?.sessionId ?? ''
    if (LOG) appendFileSync(LOG, `${JSON.stringify({ sessionId, prompt: params?.prompt ?? [] })}\n`)
    // Sent once the client is surely subscribed: the server drops repeats, and
    // an update that lands before the client's session exists is not replayed.
    if (!advertised.has(sessionId)) {
      advertised.add(sessionId)
      advertiseCommands(sessionId)
    }
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'received' }
        }
      }
    })
    send({ id, result: { stopReason: 'end_turn' } })
  } else if (method === 'session/cancel') {
    // nothing runs long enough to cancel
  } else if (id !== undefined && method !== undefined) {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  try {
    handle(JSON.parse(line) as Incoming)
  } catch (error) {
    console.error(`[composer-agent] bad frame: ${error}`)
  }
}
