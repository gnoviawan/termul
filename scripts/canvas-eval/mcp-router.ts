/**
 * The `termul` MCP server an eval agent talks to.
 *
 * Instructions and tool definitions come from the real Termul child
 * (`<termul binary> --internal-mcp-plan-server`), so the agent sees what it
 * sees in the app. The harness tools run in that child. Canvas tools run in a
 * headless figcraft engine (`figcraft-cli mcp`) instead of the in-app canvas.
 * `--mode baseline` hides the harness tools and the instruction sentences that
 * name them.
 *
 * After every call that can change the document, the router saves it to
 * `design.figcraft` and writes its tree to `document.json`, so the runner can
 * render and check the result even when the agent is stopped early. Every
 * call is logged to `calls.jsonl`.
 *
 * Usage: node mcp-router.ts --mode harness|baseline --termul <exe> --figcraft <exe> --out <dir>
 */

import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { type Json, type Rpc, Upstream } from './upstream.ts'

interface ToolDefinition {
  name: string
  [key: string]: unknown
}

const HARNESS_TOOLS = new Set(['read_canvas_guide', 'get_canvas_style'])
/** Host tools that need Termul's parent process, which the eval does not run. */
const PARENT_TOOLS = new Set(['plan', 'browser', 'ask_user', 'set_session_title'])
const READ_ONLY = new Set([
  'list_commands',
  'inspect_document',
  'get_node',
  'screenshot',
  'export',
  'inspect_ui',
  ...HARNESS_TOOLS
])

function flag(name: string): string {
  const at = process.argv.indexOf(`--${name}`)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  if (!value) {
    process.stderr.write(`mcp-router: --${name} is required\n`)
    process.exit(2)
  }
  return value
}

const mode = flag('mode')
const out = resolve(flag('out'))
const designPath = join(out, 'design.figcraft')
const started = Date.now()

/** The instructions without the sentences that name a harness tool. */
function withoutHarness(instructions: string): string {
  return instructions
    .split(/(?<=\.)\s+/)
    .filter((sentence) => ![...HARNESS_TOOLS].some((tool) => sentence.includes(tool)))
    .join(' ')
}

const termul = new Upstream(
  spawn(flag('termul'), ['--internal-mcp-plan-server'], {
    env: {
      ...process.env,
      TERMUL_PLAN_PORT: '9',
      TERMUL_PLAN_TOKEN: 'canvas-eval',
      TERMUL_PLAN_SESSION_ID: 'canvas-eval'
    }
  }),
  join(out, 'termul-child.log')
)
const figcraft = new Upstream(
  spawn(flag('figcraft'), ['mcp', '--no-system-fonts'], { cwd: out }),
  join(out, 'figcraft.log')
)

const ready = (async () => {
  const [hello] = await Promise.all([termul.open(), figcraft.open()])
  const listed = await termul.request('tools/list', {})
  const failed = hello.error ?? listed.error
  if (failed) throw new Error(String(failed.message))
  const full = String(hello.result?.instructions ?? '')
  const instructions = mode === 'baseline' ? withoutHarness(full) : full
  const tools = (listed.result?.tools as ToolDefinition[]).filter(
    (tool) => !PARENT_TOOLS.has(tool.name) && (mode !== 'baseline' || !HARNESS_TOOLS.has(tool.name))
  )
  writeFileSync(
    join(out, 'session.json'),
    JSON.stringify({ mode, instructions, tools: tools.map((tool) => tool.name) }, null, 2)
  )
  return { instructions, tools }
})()
// Every handler awaits `ready` and reports its failure, so a rejection before the first message must not kill the router.
ready.catch(() => {})

async function snapshot() {
  await figcraft.request('tools/call', { name: 'save_file', arguments: { path: designPath } })
  const tree = await figcraft.request('tools/call', {
    name: 'inspect_document',
    arguments: { depth: 64 }
  })
  const content = tree.result?.content as { text?: string }[] | undefined
  if (content?.[0]?.text) writeFileSync(join(out, 'document.json'), content[0].text)
}

async function callTool(params: Json): Promise<Json> {
  const { tools } = await ready
  const name = String(params.name)
  if (!tools.some((tool) => tool.name === name)) {
    return { content: [{ type: 'text', text: `unknown tool \`${name}\`` }], isError: true }
  }
  const forwarded = name === 'save_file' ? { ...params, arguments: { path: designPath } } : params
  const upstream = HARNESS_TOOLS.has(name) ? termul : figcraft
  const at = Date.now()
  const reply = await upstream.request('tools/call', forwarded)
  const result = reply.result ?? {
    content: [{ type: 'text', text: JSON.stringify(reply.error) }],
    isError: true
  }
  appendFileSync(
    join(out, 'calls.jsonl'),
    `${JSON.stringify({ at: at - started, ms: Date.now() - at, tool: name, isError: result.isError === true })}\n`
  )
  if (!READ_ONLY.has(name) && result.isError !== true) await snapshot()
  return result
}

async function handle(message: Rpc): Promise<Rpc | undefined> {
  if (message.id === undefined) return undefined
  const reply = (result: Json): Rpc => ({ jsonrpc: '2.0', id: message.id, result })
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      const { instructions } = await ready
      return reply({
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'termul', version: 'canvas-eval' },
        instructions
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: (await ready).tools })
    case 'tools/call':
      return reply(await callTool(params))
    case 'resources/list':
    case 'resources/templates/list':
    case 'resources/read':
    case 'prompts/list':
    case 'prompts/get': {
      const upstream = await figcraft.request(message.method, params)
      return { jsonrpc: '2.0', id: message.id, result: upstream.result, error: upstream.error }
    }
    default:
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` }
      }
  }
}

let queue = Promise.resolve()
createInterface({ input: process.stdin })
  .on('line', (line) => {
    let message: Rpc
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    queue = queue.then(async () => {
      const answer = await handle(message).catch((error: unknown): Rpc | undefined =>
        message.id === undefined
          ? undefined
          : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error) } }
      )
      if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`)
    })
  })
  .on('close', () => {
    queue.finally(() => {
      termul.close()
      figcraft.close()
      process.exit(0)
    })
  })
