/**
 * The matrix's ACP agent: the chat scenario agent (`tools/chat/scenario-agent.ts`)
 * behind a proxy that answers three extra prompts itself, so the chat surfaces
 * the scenario agent cannot reach still get a scripted reference:
 *
 * - `matrix plan` streams a plan update (the plan panel) and a short reply.
 * - `matrix permission` starts a tool call and asks the client for permission
 *   (the permission prompt), then replies with the option the user picked.
 * - `matrix hold` replies, then keeps the turn open for `HOLD_MS` (or until
 *   cancelled), so a second prompt lands in the prompt queue.
 *
 * Every other frame passes through to the scenario agent unchanged.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'

type Id = number | string

interface Frame {
  id?: Id
  method?: string
  params?: { sessionId?: string; prompt?: Array<{ text?: string }> }
  result?: { outcome?: { outcome?: string; optionId?: string } }
}

export const MATRIX_PROMPTS = {
  plan: 'matrix plan',
  permission: 'matrix permission',
  hold: 'matrix hold'
} as const
export const PLAN_ENTRIES = [
  'Read the router module',
  'Write the hash router tests',
  'Update the router docs'
]
export const PERMISSION_TITLE = 'Run the router test suite'
export const PERMISSION_GRANTED = 'Permission answer: allow-once'
export const HOLD_REPLY = 'Holding this turn open for the queue.'
const HOLD_MS = 25_000

function send(frame: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}

const update = (sessionId: string, body: Record<string, unknown>) =>
  send({ method: 'session/update', params: { sessionId, update: body } })
const say = (sessionId: string, text: string) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pending = new Map<Id, (frame: Frame) => void>()
let requestCounter = 0
let cancelled = false

function request(method: string, params: object): Promise<Frame> {
  const id = `m1-${++requestCounter}`
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ id, method, params })
  })
}

async function plan(sessionId: string): Promise<void> {
  const statuses = ['completed', 'in_progress', 'pending']
  update(sessionId, {
    sessionUpdate: 'plan',
    entries: PLAN_ENTRIES.map((content, i) => ({
      content,
      priority: 'medium',
      status: statuses[i]
    }))
  })
  await sleep(200)
  say(sessionId, 'Here is the plan for the router work.')
}

async function permission(sessionId: string): Promise<void> {
  const toolCallId = `m1-permission-${requestCounter}`
  const toolCall = {
    toolCallId,
    title: PERMISSION_TITLE,
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'bun test router' }
  }
  update(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
  const reply = await request('session/request_permission', {
    sessionId,
    toolCall,
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
    ]
  })
  const outcome = reply.result?.outcome
  const answer =
    outcome?.outcome === 'selected' ? (outcome.optionId ?? '') : (outcome?.outcome ?? 'none')
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: answer === 'allow-once' ? 'completed' : 'failed'
  })
  say(sessionId, `Permission answer: ${answer}`)
}

async function hold(sessionId: string): Promise<void> {
  say(sessionId, HOLD_REPLY)
  const until = Date.now() + HOLD_MS
  while (!cancelled && Date.now() < until) await sleep(100)
}

const HANDLERS: Record<string, (sessionId: string) => Promise<void>> = {
  [MATRIX_PROMPTS.plan]: plan,
  [MATRIX_PROMPTS.permission]: permission,
  [MATRIX_PROMPTS.hold]: hold
}

async function answer(
  id: Id,
  sessionId: string,
  handler: (sessionId: string) => Promise<void>
): Promise<void> {
  cancelled = false
  try {
    await handler(sessionId)
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
  } catch (error) {
    console.error(`[matrix-agent] prompt failed: ${error}`)
    send({ id, error: { code: -32603, message: String(error) } })
  }
}

/** True when the proxy handled the frame itself. */
function intercept(frame: Frame): boolean {
  if (frame.method === undefined && frame.id !== undefined && pending.has(frame.id)) {
    pending.get(frame.id)?.(frame)
    pending.delete(frame.id)
    return true
  }
  if (frame.method === 'session/cancel') cancelled = true
  if (frame.method !== 'session/prompt' || frame.id === undefined) return false
  const text = (frame.params?.prompt ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim()
  const handler = HANDLERS[text]
  if (!handler) return false
  void answer(frame.id, frame.params?.sessionId ?? '', handler)
  return true
}

if (import.meta.main) {
  const child = spawn('bun', [path.join(import.meta.dir, '../chat/scenario-agent.ts')], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  void (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.trim()) process.stdout.write(`${line}\n`)
    }
  })()
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    try {
      if (!intercept(JSON.parse(line) as Frame)) child.stdin.write(`${line}\n`)
    } catch (error) {
      console.error(`[matrix-agent] bad frame: ${error}`)
    }
  }
  child.kill()
}
