/**
 * ACP stdio agent that plays back the scripted chat in `script.ts`, one turn
 * per prompt, with word-chunked streaming. Same wire shapes as the perf
 * toolkit's fake agent (tools/perf/fake-agent/fake-agent.ts), which cannot
 * script thoughts, edits with diffs and tables in one turn.
 *
 * A prompt `storm <seconds> <rate> <chunkChars>` (see `parseStorm`) instead
 * streams agent_message_chunk updates at a fixed rate for a fixed time, the
 * shape of the perf toolkit's stream-storm, and appends one JSONL line per
 * chunk to `$CHAT_STORM_LOG` with the wall-clock ms it was written to stdout.
 * The prompt carries no path, so it can be typed into the web launcher. Every
 * chunk ends with a unique word (`stormMarker(id)`) a client can look for
 * to time when that chunk reached the screen.
 */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { type Step, scriptedTurn, type ToolStep } from './script.ts'

export interface StormDirective {
  seconds: number
  /** Chunks per second (stream-storm default: 20). */
  rate: number
  /** Approximate characters per chunk (stream-storm default: 120). */
  chunkChars: number
}

export function stormPrompt(directive: StormDirective): string {
  return `storm ${directive.seconds} ${directive.rate} ${directive.chunkChars}`
}

export function parseStorm(text: string): StormDirective | null {
  const match = /^storm (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+)\s*$/.exec(text.trim())
  return match
    ? { seconds: Number(match[1]), rate: Number(match[2]), chunkChars: Number(match[3]) }
    : null
}

export interface StormChunkRecord {
  id: number
  /** Wall-clock ms when the chunk was written to the host. */
  t: number
  bytes: number
  /** Characters of storm text emitted so far, this chunk included. */
  offset: number
}

type Id = number | string

interface Incoming {
  id?: Id
  method?: string
  params?: {
    sessionId?: string
    cwd?: string
    prompt?: Array<{ type: string; text?: string }>
  }
}

const STORM_LOG = process.env.CHAT_STORM_LOG
const CHUNK_WORDS = 4
const CHUNK_DELAY_MS = 18
const TOOL_RUN_MS = 250

const sessions = new Map<string, { cwd: string; prompts: number }>()
let sessionCounter = 0
let cancelled = false

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: 'session/update', params: { sessionId, update: body } })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Split prose into runs of a few words, keeping every whitespace character. */
function chunks(text: string): string[] {
  const parts = text.split(/(\s+)/)
  const out: string[] = []
  for (let i = 0; i < parts.length; i += CHUNK_WORDS * 2) {
    out.push(parts.slice(i, i + CHUNK_WORDS * 2).join(''))
  }
  return out.filter((chunk) => chunk.length > 0)
}

async function stream(sessionId: string, kind: string, text: string): Promise<void> {
  for (const chunk of chunks(text)) {
    if (cancelled) return
    update(sessionId, { sessionUpdate: kind, content: { type: 'text', text: chunk } })
    await sleep(CHUNK_DELAY_MS)
  }
}

async function runTool(sessionId: string, tool: ToolStep, turn: number): Promise<void> {
  const toolCallId = `${tool.id}-${turn}`
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: tool.title,
    kind: tool.kind,
    status: 'in_progress',
    locations: tool.locations,
    rawInput: tool.rawInput,
    ...(tool.content && { content: tool.content })
  })
  await sleep(TOOL_RUN_MS)
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    ...(tool.output !== undefined && {
      rawOutput: { output: tool.output },
      content: [
        ...(tool.content ?? []),
        { type: 'content', content: { type: 'text', text: tool.output } }
      ]
    })
  })
}

async function playTurn(sessionId: string, steps: Step[], turn: number): Promise<void> {
  for (const step of steps) {
    if (cancelled) return
    if (step.step === 'thought') await stream(sessionId, 'agent_thought_chunk', step.text)
    else if (step.step === 'say') await stream(sessionId, 'agent_message_chunk', step.text)
    else await runTool(sessionId, step, turn)
  }
}

const STORM_WORDS =
  'stream render commit flush coalesce window frame latency chunk buffer pipeline store selector markdown parse transcript update'.split(
    ' '
  )

/** The word that ends storm chunk `id`; unique, so its first paint is that chunk's paint. */
export function stormMarker(id: number): string {
  return `mk${id}x`
}

/** Deterministic storm text: mostly prose, with bold leads, fences and tables mixed in. */
function stormText(chars: number, id: number): string {
  const words: string[] = []
  let length = 0
  for (let k = 0; length < chars; k++) {
    const word = STORM_WORDS[(id * 7 + k * 3) % STORM_WORDS.length]
    words.push(word)
    length += word.length + 1
  }
  const marker = stormMarker(id)
  const flavor = id % 20
  if (flavor < 2) return `\n\n**${words[0]}** ${words.slice(1).join(' ')} ${marker} `
  if (flavor < 4)
    return `\n\n${'```'}ts\nconst chunk${id} = '${words.join(' ')}' // ${marker}\n${'```'}\n\n`
  if (flavor === 4)
    return `\n\n| chunk | words |\n| --- | ---: |\n| ${marker} | ${words.length} |\n\n`
  return `${words.join(' ')} ${marker} `
}

async function storm(sessionId: string, directive: StormDirective): Promise<void> {
  const interval = 1000 / directive.rate
  const total = Math.round(directive.seconds * directive.rate)
  const start = performance.now()
  let offset = 0
  for (let id = 0; id < total && !cancelled; id++) {
    const due = start + id * interval
    const wait = due - performance.now()
    if (wait > 0) await sleep(wait)
    const text = stormText(directive.chunkChars, id)
    const t = Date.now()
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    offset += text.length
    const record: StormChunkRecord = { id, t, bytes: Buffer.byteLength(text), offset }
    if (STORM_LOG) appendFileSync(STORM_LOG, `${JSON.stringify(record)}\n`)
  }
}

function promptText(params: Incoming['params']): string {
  return (params?.prompt ?? []).map((block) => block.text ?? '').join('')
}

async function handlePrompt(id: Id, sessionId: string, text: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    send({ id, error: { code: -32602, message: `unknown session ${sessionId}` } })
    return
  }
  cancelled = false
  try {
    const directive = parseStorm(text)
    if (directive) {
      await storm(sessionId, directive)
    } else {
      const turn = session.prompts++
      await playTurn(sessionId, scriptedTurn(turn, session.cwd), turn)
    }
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
  } catch (error) {
    console.error(`[chat-agent] prompt failed: ${error}`)
    send({ id, error: { code: -32603, message: String(error) } })
  }
}

function handle(message: Incoming): void {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { list: false, resume: false, close: false }
        },
        authMethods: []
      }
    })
  } else if (method === 'session/new') {
    const sessionId = `chat-${process.pid}-${++sessionCounter}`
    sessions.set(sessionId, { cwd: params?.cwd ?? process.cwd(), prompts: 0 })
    send({ id, result: { sessionId } })
  } else if (method === 'session/prompt' && id !== undefined) {
    void handlePrompt(id, params?.sessionId ?? '', promptText(params))
  } else if (method === 'session/cancel') {
    cancelled = true
  } else if (id !== undefined && method !== undefined) {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

if (import.meta.main) {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    try {
      handle(JSON.parse(line) as Incoming)
    } catch (error) {
      console.error(`[chat-agent] bad frame: ${error}`)
    }
  }
}
