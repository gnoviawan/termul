/**
 * ACP stdio agent for the canvas checks: it calls the canvas MCP tools the way a real agent does.
 * At `session/new` the host hands every agent its own MCP server (`mcpServers`); a prompt
 * `canvas-call <tool> <json arguments>` runs that tool on it once, appends
 * `{tool, arguments, result}` to `$CANVAS_AGENT_OUT` (JSON lines) and replies with the result's
 * text. The call goes host -> the renderer holding the project's canvas -> its bridge -> the
 * editor, so a check reads back what the editor itself answered.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

type Id = number | string

interface McpServer {
  name: string
  command: string
  args?: string[]
  env?: { name: string; value: string }[] | Record<string, string>
}

interface Incoming {
  id?: Id
  method?: string
  params?: {
    sessionId?: string
    mcpServers?: McpServer[]
    prompt?: { text?: string }[]
  }
}

const OUT = process.env.CANVAS_AGENT_OUT

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function say(sessionId: string, text: string): void {
  send({
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    }
  })
}

/** One MCP stdio client per session, started on its first call. */
function mcpClient(server: McpServer) {
  const env = Array.isArray(server.env)
    ? Object.fromEntries(server.env.map((v) => [v.name, v.value]))
    : (server.env ?? {})
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const pending = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>()
  let next = 0
  createInterface({ input: child.stdout }).on('line', (line) => {
    let reply: { id?: number; result?: unknown; error?: unknown }
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    if (typeof reply.id === 'number') pending.get(reply.id)?.(reply)
  })
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      next += 1
      pending.set(next, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`)
    })
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gpuix-canvas-agent', version: '0' }
  }).then(() => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    )
  })
  return {
    async call(tool: string, args: unknown) {
      await ready
      return request('tools/call', { name: tool, arguments: args })
    },
    stop: () => child.kill()
  }
}

const sessions = new Map<
  string,
  { server: McpServer | null; client: ReturnType<typeof mcpClient> | null }
>()
let counter = 0

async function prompt(id: Id, sessionId: string, text: string): Promise<void> {
  const session = sessions.get(sessionId)
  const match = /^canvas-call (\S+) ([\s\S]+)$/.exec(text.trim())
  if (!session || !match) {
    say(
      sessionId,
      `canvas-agent: expected "canvas-call <tool> <json>", got ${JSON.stringify(text)}`
    )
    send({ id, result: { stopReason: 'end_turn' } })
    return
  }
  const [, tool, json] = match
  let result: unknown
  try {
    if (!session.server) throw new Error('the host gave this session no MCP server')
    session.client ??= mcpClient(session.server)
    const reply = await session.client.call(tool, JSON.parse(json))
    result = reply.error ? { error: reply.error } : reply.result
  } catch (error) {
    result = { error: String(error) }
  }
  if (OUT) appendFileSync(OUT, `${JSON.stringify({ tool, arguments: JSON.parse(json), result })}\n`)
  const content = (result as { content?: { text?: string }[] })?.content
  say(
    sessionId,
    `canvas-call ${tool}: ${content?.map((c) => c.text ?? '').join(' ') ?? JSON.stringify(result)}`
  )
  send({ id, result: { stopReason: 'end_turn' } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message: Incoming
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }
    })
  } else if (method === 'session/new') {
    const sessionId = `canvas-${process.pid}-${++counter}`
    const server = params?.mcpServers?.find((s) => s.command) ?? null
    sessions.set(sessionId, { server, client: null })
    if (OUT)
      appendFileSync(
        OUT,
        `${JSON.stringify({ session: sessionId, mcpServers: params?.mcpServers?.map((s) => s.name) })}\n`
      )
    send({ id, result: { sessionId } })
  } else if (method === 'session/prompt' && id !== undefined) {
    const text = (params?.prompt ?? []).map((block) => block.text ?? '').join('')
    void prompt(id, params?.sessionId ?? '', text)
  } else if (method === 'session/cancel') {
    // Calls are short; nothing to cancel.
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
})

process.on('exit', () => {
  for (const session of sessions.values()) session.client?.stop()
})
