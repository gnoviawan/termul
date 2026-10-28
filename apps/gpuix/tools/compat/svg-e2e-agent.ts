/**
 * The ACP agent `svg-e2e.ts` chats with: every prompt is answered with the
 * markdown in `SVG_E2E_REPLY_FILE`, which embeds hostile SVG images the way a
 * model reply quoting web content could.
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Id = number | string
interface Incoming {
  id?: Id
  method?: string
  params?: { sessionId?: string }
}

const reply = readFileSync(process.env.SVG_E2E_REPLY_FILE as string, 'utf8')
let sessions = 0

function send(frame: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}

function handle({ id, method, params }: Incoming): void {
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: []
      }
    })
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: `svg-e2e-${process.pid}-${++sessions}` } })
  } else if (method === 'session/prompt' && id !== undefined) {
    send({
      method: 'session/update',
      params: {
        sessionId: params?.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }
      }
    })
    send({ id, result: { stopReason: 'end_turn' } })
  } else if (id !== undefined && method !== undefined) {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) handle(JSON.parse(line) as Incoming)
}
