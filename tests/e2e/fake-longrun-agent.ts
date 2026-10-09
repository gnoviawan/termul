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
 * - `session/load` / `session/resume` → accept (reopen flows round-trip).
 * - `session/cancel` → finish the session's in-flight prompt as cancelled.
 *   The server sends this as a JSON-RPC NOTIFICATION (no id) — the reply
 *   only goes out when an id is present.
 *
 * Env knobs (validated: a malformed value falls back to the default rather
 * than yielding NaN, which would make the duration comparison never fire):
 * - DURATION_SEC (default 300): turn length.
 * - RATE (default 1): chunks per second per session. The timer floor of
 *   100ms caps the effective rate at 10/s — higher values behave as 10.
 * - CHUNK_CHARS (default 200): text length per chunk.
 * - WIRE_LOG: when set, every inbound line is appended to that file (via
 *   stderr-style fs append; useful for debugging protocol mismatches).
 *
 * Prompt markers (crash-recovery suite): `[DURATION:n]` overrides the turn
 * length for that prompt, and `[CRASH]`/`[CRASH:<seconds>]` makes the agent
 * process exit(1) that many seconds after accepting the prompt — but ONLY
 * while the crash is armed (one-shot `CRASH_ARM_FILE`, consumed on use):
 * the host re-sends the persisted open user turn verbatim when a dead chat
 * is reopened, and a real crash is a process accident, not a property of
 * the prompt text. The default 0.4s lands before the first 1s chunk tick,
 * so the persisted transcript ends on the user bubble.
 *
 * Prompt markers (elicitation suite): `[ELICIT]` makes the agent issue an
 * ACP `elicitation/create` request to the client (agent→client JSON-RPC
 * request — the only outbound request this fake makes) with the Devin
 * `ask_user_question` wire shape captured for GH-935: form mode, a `q0`
 * single-select (`oneOf` titled options), a `q1` multi-select
 * (`items.anyOf` titled options), and `_meta["cognition.ai/allowOther"]`.
 * The turn then holds open WITHOUT streaming until the client's response
 * arrives; the verbatim result is echoed into the transcript as
 * `ELICIT_ANSWER=<json>` in an `agent_message_chunk` so specs parse the
 * real wire response back, and the prompt resolves `end_turn`.
 *
 * Prompt marker (mobile-overlay-back-stack suite): `[RICH]` answers with one
 * short turn that carries the content the chat's own overlays hang off — an
 * external markdown link (link-safety confirm), an inline image (lightbox)
 * and a subagent tool call (details dialog) — then ends it at once.
 *
 * `[PERMISSION]` (mobile shell suites): right after accepting the prompt the
 * agent asks the host for a tool permission (`session/request_permission`)
 * and leaves it unanswered, so the chat shows a pending approval — "needs
 * you" — for as long as a client is connected (the host denies it only after
 * its disconnect grace). The turn keeps streaming.
 *
 * Composer fixture (mobile-composer-row suite, additive): a `session/new`
 * whose cwd contains `composer-row-e2e` advertises two modes plus a model and
 * a thought-level config option (so the composer toolbar has every chip), and
 * answers `session/set_config_option` for them. A `[USAGE]` prompt marker
 * reports a baseline and a grown context-window snapshot (with a reported
 * cost) so the context ring appears. Any other cwd or prompt behaves as before.
 *
 * Prompt markers (mobile chat dock suite), both applied right after the
 * prompt is accepted; the turn then streams as usual:
 * - `[DOCK]` pushes a 5-entry plan (3 completed) and three completed edit
 *   tool calls (src/auth.ts +10, src/session.ts +4, src/token.ts +3 -2:
 *   +17 -2 in total): the content of the chat dock's plan and
 *   changed-files bars.
 * - `[ASK:permission]`, `[ASK:permission-none]` (a request with no
 *   options), `[ASK:question]` or `[ASK:elicitation]` sends the matching
 *   agent-to-client request. When the client answers, the agent streams one
 *   chunk `[ANSWERED <kind> <outcome>]` (outcome: the chosen optionId, the
 *   chosen values, the elicitation action, or `cancelled`).
 *
 * Mobile approval edge states suite (additive): every `[ASK:<kind>]` accepts
 * an optional delay, `[ASK:<kind>:<seconds>]`, so the request can reach a chat
 * that is no longer on screen. `[ASK:elicitation-boolean]` sends a form with a
 * REQUIRED boolean `confirm` and an optional boolean `notify`; its answer
 * chunk lists the content the client sent, as
 * `[ANSWERED elicitation-boolean accept confirm=false]` (`notify` is absent
 * when the client left it out).
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, unlinkSync } from 'node:fs'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
interface JsonRpcMessage {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: JsonValue
  /** Set on RESPONSES to our outbound requests (elicitation/create). */
  result?: JsonValue
  error?: JsonValue
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const DURATION_SEC = envNumber('DURATION_SEC', 300)
const RATE = envNumber('RATE', 1)
const CHUNK_CHARS = envNumber('CHUNK_CHARS', 200)

const WIRE_LOG = process.env.WIRE_LOG ?? ''
const wireLog = (line: string): void => {
  if (!WIRE_LOG) return
  try {
    appendFileSync(WIRE_LOG, `${line}\n`)
  } catch {
    /* best effort */
  }
}

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
  /** Per-prompt override from a `[DURATION:n]` marker, else DURATION_SEC. */
  durationSec?: number
  /**
   * `[ELICIT]` turns hold open on the client's `elicitation/create`
   * response — they never stream tick chunks and never hit the duration
   * timer (the response itself ends the turn).
   */
  awaitingElicitation?: boolean
}

function promptText(prompt: JsonValue | undefined): string {
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((block) =>
      block !== null && typeof block === 'object' && 'text' in block ? String(block.text ?? '') : ''
    )
    .join('\n')
}

/**
 * Crash delay (seconds) when the prompt text carries a `[CRASH[:n]]`
 * marker, else null. ACP `session/prompt` params carry `prompt` as an
 * array of content blocks (`{ type: 'text', text }`).
 */
function crashAfterSeconds(prompt: JsonValue | undefined): number | null {
  const match = /\[CRASH(?::(\d+(?:\.\d+)?))?\]/.exec(promptText(prompt))
  if (!match) return null
  return match[1] ? Number(match[1]) : 0.4
}

/**
 * Per-turn duration override from a `[DURATION:n]` marker — a test that
 * needs the turn to END (close-after-finish paths) can't wait the default
 * 300s.
 */
function durationSeconds(prompt: JsonValue | undefined): number | undefined {
  const match = /\[DURATION:(\d+(?:\.\d+)?)\]/.exec(promptText(prompt))
  return match ? Number(match[1]) : undefined
}

/** `[ELICIT]` marker: issue an `elicitation/create` request mid-turn. */
function elicitationRequested(prompt: JsonValue | undefined): boolean {
  return /\[ELICIT\]/.test(promptText(prompt))
}

/**
 * The two-question `requestedSchema` Devin sends for `ask_user_question`,
 * captured live for GH-935 (verbatim): `q0` is a single-select string
 * property with titled `oneOf` options, `q1` a multi-select array property
 * with titled `items.anyOf` options. Both are `required` — unanswered
 * questions come back omitted from `content` (skipped), not errors.
 */
const ELICIT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['q0', 'q1'],
  properties: {
    q0: {
      type: 'string',
      title: 'Color',
      description: 'Which color should I use?',
      oneOf: [
        { const: 'Red', title: 'Use the red color' },
        { const: 'Blue', title: 'Use the blue color' }
      ]
    },
    q1: {
      type: 'array',
      title: 'Features',
      description: 'Which features should I enable?',
      minItems: 1,
      items: {
        anyOf: [
          { const: 'Logging', title: 'Enable logging' },
          { const: 'Tracing', title: 'Enable tracing' }
        ]
      }
    }
  }
}

/** A 1x1 PNG: small enough to inline, real enough for the browser to decode. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * The `[RICH]` turn: a link, an image and a subagent call, then `end_turn`.
 * Nothing is registered in `inFlightBySession`, so no timer streams after it.
 */
function replyRichTurn(id: number | string | undefined, sessionId: string): void {
  const update = (body: JsonValue): void => notify('session/update', { sessionId, update: body })
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Docs: [Example docs](https://example.com/docs)\n\n' }
  })
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }
  })
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'rich-subagent-1',
    title: 'Delegate review',
    kind: 'other',
    status: 'completed',
    rawInput: {
      subagent_type: 'reviewer',
      description: 'Review the overlay change',
      prompt: 'Review the overlay change for dead back presses.'
    }
  })
  respond(id, { stopReason: 'end_turn' })
}

/**
 * Delay (seconds) before the permission request when the prompt text carries a
 * `[PERMISSION[:n]]` marker (0 without a number), else null.
 */
function permissionDelaySeconds(prompt: JsonValue | undefined): number | null {
  const match = /\[PERMISSION(?::(\d+(?:\.\d+)?))?\]/.exec(promptText(prompt))
  if (!match) return null
  return match[1] ? Number(match[1]) : 0
}

/** Ids of the permission requests this agent sent: the host's replies carry no method. */
const permissionRequestIds = new Set<string>()

function requestPermission(sessionId: string): void {
  const requestId = `perm-${randomUUID().slice(0, 8)}`
  permissionRequestIds.add(requestId)
  write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: {
          toolCallId: `call-${requestId}`,
          title: 'Run the e2e tool',
          kind: 'execute',
          status: 'pending'
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
  )
}

/** A `session/new` cwd carrying this marker gets the composer fixture below. */
const COMPOSER_CWD_MARKER = 'composer-row-e2e'

type ComposerOptionValues = Record<string, string>
const composerValuesBySession = new Map<string, ComposerOptionValues>()

function composerConfigOptions(values: ComposerOptionValues): JsonValue[] {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: values.model ?? 'opus-5-5',
      options: [
        { value: 'opus-5-5', name: 'Opus 5.5' },
        { value: 'sonnet-5-5', name: 'Sonnet 5.5' }
      ]
    },
    {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: values.thought_level ?? 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ]
    }
  ]
}

/** Report a baseline then a grown context window, so the ring clears its 1% floor. */
function reportUsage(sessionId: string): void {
  const update = (used: number, extra: Record<string, JsonValue> = {}): void =>
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'usage_update', used, size: 200_000, ...extra }
    })
  update(20_000)
  update(70_000, { cost: { amount: 0.0421, currency: 'USD' } })
}

type AskKind = 'permission' | 'permission-none' | 'question' | 'elicitation' | 'elicitation-boolean'

const ASK_MARKER =
  /\[ASK:(permission-none|permission|question|elicitation-boolean|elicitation)(?::(\d+(?:\.\d+)?))?\]/

/** The agent-to-client request an `[ASK:<kind>]` marker asks for, else null. */
function askKind(prompt: JsonValue | undefined): AskKind | null {
  const match = ASK_MARKER.exec(promptText(prompt))
  return match ? (match[1] as AskKind) : null
}

/** Seconds to wait before sending the `[ASK:<kind>:<seconds>]` request (0 without a delay). */
function askDelaySeconds(prompt: JsonValue | undefined): number {
  const match = ASK_MARKER.exec(promptText(prompt))
  return match?.[2] ? Number(match[2]) : 0
}

/** Outstanding agent-to-client requests, keyed by the id this agent minted. */
const pendingAsks = new Map<string, { sessionId: string; kind: AskKind }>()
let nextAskId = 1

function ask(sessionId: string, kind: AskKind): void {
  const id = `fake-ask-${nextAskId++}`
  pendingAsks.set(id, { sessionId, kind })
  const send = (method: string, params: JsonValue): void =>
    write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  switch (kind) {
    case 'permission':
    case 'permission-none':
      send('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: `fake-perm-${id}`,
          title: 'npm test -- auth',
          kind: 'execute',
          status: 'pending'
        },
        // Reject first on purpose: the prompt orders allows before rejects.
        options:
          kind === 'permission-none'
            ? []
            : [
                { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
                { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
              ]
      })
      break
    case 'question':
      send('_session/question', {
        sessionId,
        question: 'Which test suite should run?',
        options: [
          { value: 'unit', label: 'Unit tests', description: 'Fast, no network' },
          { value: 'e2e', label: 'End-to-end tests' }
        ]
      })
      break
    case 'elicitation-boolean':
      send('elicitation/create', {
        mode: 'form',
        sessionId,
        message: 'Confirm the deployment',
        // A required boolean and an optional one, both left Off by default.
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean' }, notify: { type: 'boolean' } },
          required: ['confirm']
        }
      })
      break
    case 'elicitation':
      send('elicitation/create', {
        mode: 'form',
        sessionId,
        message: 'Name the branch to test',
        // One field per kind the prompt renders differently: a required text
        // input, an optional enum (select) and an optional boolean (switch).
        requestedSchema: {
          type: 'object',
          properties: {
            branch: { type: 'string' },
            env: { type: 'string', enum: ['staging', 'production'] },
            verbose: { type: 'boolean' }
          },
          required: ['branch']
        }
      })
      break
  }
}

/** The client answered one of our requests: report the outcome in the transcript. */
function onAskAnswered(
  id: string,
  msg: JsonRpcMessage & { result?: JsonValue; error?: JsonValue }
): void {
  const pending = pendingAsks.get(id)
  if (!pending) return
  pendingAsks.delete(id)
  const result = (msg.result ?? {}) as Record<string, JsonValue>
  const outcome = result.outcome as Record<string, JsonValue> | undefined
  let summary = 'error'
  if (msg.error === undefined) {
    if (pending.kind === 'elicitation') summary = String(result.action ?? 'unknown')
    else if (pending.kind === 'elicitation-boolean') {
      const content = (result.content ?? {}) as Record<string, JsonValue>
      const sent = Object.entries(content).map(([name, value]) => `${name}=${String(value)}`)
      summary = [String(result.action ?? 'unknown'), ...sent].join(' ')
    } else if (pending.kind === 'question') {
      summary = Array.isArray(result.values) ? result.values.join(',') : 'cancelled'
    } else {
      summary = outcome?.outcome === 'selected' ? String(outcome.optionId) : 'cancelled'
    }
  }
  notify('session/update', {
    sessionId: pending.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `[ANSWERED ${pending.kind} ${summary}]` }
    }
  })
}

/** `[DOCK]`: the plan and changed-files content of the mobile chat dock. */
function pushDock(sessionId: string): void {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read the auth module', priority: 'high', status: 'completed' },
        { content: 'Add the token store', priority: 'high', status: 'completed' },
        { content: 'Wire the session refresh', priority: 'medium', status: 'completed' },
        { content: 'Cover login with tests', priority: 'medium', status: 'in_progress' },
        { content: 'Update the changelog', priority: 'low', status: 'pending' }
      ]
    }
  })
  const lines = (count: number, tag: string): string =>
    Array.from({ length: count }, (_, i) => `${tag}${i + 1}`).join('\n')
  const edits: Array<{ path: string; oldText: string | null; newText: string }> = [
    { path: 'src/auth.ts', oldText: null, newText: lines(10, 'auth') },
    { path: 'src/session.ts', oldText: 'a\nb', newText: `a\nb\n${lines(4, 'z')}` },
    {
      path: 'src/token.ts',
      oldText: 'keep\nold1\nold2\nend',
      newText: 'keep\nnew1\nnew2\nnew3\nend'
    }
  ]
  edits.forEach((edit, i) => {
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `fake-edit-${i + 1}`,
        title: `Edit ${edit.path}`,
        kind: 'edit',
        status: 'completed',
        locations: [{ path: edit.path }],
        content: [{ type: 'diff', path: edit.path, oldText: edit.oldText, newText: edit.newText }]
      }
    })
  })
}

/** Per-session in-flight turns — concurrent sessions stream simultaneously. */
const inFlightBySession = new Map<string, InFlight>()

interface PendingElicitation {
  /** The held `session/prompt` request id for the awaiting turn. */
  promptId: number | string
  sessionId: string
}

/**
 * Outbound `elicitation/create` requests awaiting the client's response,
 * keyed by OUR request id (agent-chosen `elicit-N`, distinct from any
 * host-chosen inbound id space).
 */
const pendingElicitations = new Map<number | string, PendingElicitation>()
let nextElicitationId = 0

/**
 * One-shot crash arming: the suite writes this file before launching a
 * `[CRASH]` prompt; the first armed prompt consumes it and kills the agent.
 * Re-sent persisted prompts (reopen resume) find it already consumed.
 */
const CRASH_ARM_FILE = process.env.TERMUL_FAKE_CRASH_ARM ?? ''

function consumeCrashArm(): boolean {
  if (!CRASH_ARM_FILE) return false
  try {
    unlinkSync(CRASH_ARM_FILE)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a held `[ELICIT]` turn when the client's `elicitation/create`
 * response arrives: echo the verbatim result (or the error object, so a
 * rejection is diagnosable from the transcript instead of a silent hang)
 * as `ELICIT_ANSWER=<json>`, then end the turn — the same notify-then-
 * respond order `tick()` uses for DONE turns.
 */
function resolveElicitation(msg: JsonRpcMessage): void {
  if (msg.id === undefined) return
  const pending = pendingElicitations.get(msg.id)
  // Unknown or already-dropped request ids are ignored — a response is not
  // a request, so there is nothing valid to reply to it with anyway.
  if (!pending) return
  pendingElicitations.delete(msg.id)
  const payload = msg.error !== undefined ? { error: msg.error } : (msg.result ?? null)
  notify('session/update', {
    sessionId: pending.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `ELICIT_ANSWER=${JSON.stringify(payload)}` }
    }
  })
  respond(pending.promptId, { stopReason: 'end_turn' })
  inFlightBySession.delete(pending.sessionId)
}

/** How long a held `[ELICIT]` turn waits for the client's response before
 * ending the turn anyway — a lost/never-answered request must not wedge the
 * session (every later prompt would fail 'turn already in progress'). */
const ELICIT_TIMEOUT_SEC = 60

function tick(): void {
  for (const inFlight of inFlightBySession.values()) {
    // `[ELICIT]` turns wait on the client's elicitation/create response;
    // no chunk stream — only the timeout below applies.
    if (inFlight.awaitingElicitation) {
      const elapsed = (Date.now() - inFlight.startedAt) / 1000
      if (elapsed >= ELICIT_TIMEOUT_SEC) {
        for (const [elicitId, pending] of pendingElicitations) {
          if (pending.sessionId === inFlight.sessionId) pendingElicitations.delete(elicitId)
        }
        notify('session/update', {
          sessionId: inFlight.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'ELICIT_ANSWER={"error":{"message":"elicitation response timed out"}}'
            }
          }
        })
        respond(inFlight.id, { stopReason: 'end_turn' })
        inFlightBySession.delete(inFlight.sessionId)
      }
      continue
    }
    const elapsed = (Date.now() - inFlight.startedAt) / 1000
    if (elapsed >= (inFlight.durationSec ?? DURATION_SEC)) {
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
  // A RESPONSE to one of our outbound requests carries `id` + `result`/
  // `error` but no `method`. Route it before the method switch so it never
  // falls into the `default` reply arm (replying to a response would be
  // protocol noise). The host's reply to a permission request sent by the
  // `[PERMISSION]` marker flow needs no answer; `[ASK:*]` requests (mobile
  // chat dock suite) are tracked in `pendingAsks`; everything else is the
  // `[ELICIT]` flow.
  if (method === undefined) {
    if (id !== undefined && permissionRequestIds.delete(String(id))) return
    if (typeof id === 'string' && pendingAsks.has(id)) {
      onAskAnswered(id, msg as JsonRpcMessage & { result?: JsonValue; error?: JsonValue })
    } else {
      resolveElicitation(msg)
    }
    return
  }
  const p = (params ?? {}) as Record<string, JsonValue>
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        // `loadSession` is a boolean on the wire — a string like 'persistent'
        // deserializes as false and the host reports loadSession=false,
        // which downgrades every reopen to read-only 'local'.
        agentCapabilities: { loadSession: true, promptCapabilities: {} },
        authMethods: []
      })
      break
    case 'newSession':
    case 'session/new': {
      const sid = `sess-${randomUUID().slice(0, 8)}`
      if (String(p.cwd ?? '').includes(COMPOSER_CWD_MARKER)) {
        composerValuesBySession.set(sid, {})
        respond(id, {
          sessionId: sid,
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'plan', name: 'Plan' }
            ]
          },
          models: [],
          configOptions: composerConfigOptions({})
        })
        break
      }
      respond(id, { sessionId: sid, modes: [], models: [] })
      break
    }
    case 'setSessionConfigOption':
    case 'session/set_config_option': {
      const sid = String(p.sessionId ?? 'unknown')
      const values = composerValuesBySession.get(sid)
      if (!values) {
        respond(id, {})
        break
      }
      values[String(p.configId)] = String(p.value)
      respond(id, { configOptions: composerConfigOptions(values) })
      break
    }
    case 'loadSession':
    case 'session/load':
    case 'resumeSession':
    case 'session/resume': {
      // Reopen: keep the session id the host asked for; the server already
      // holds the transcript, so nothing else to replay here.
      const sid = String(p.sessionId ?? `sess-${randomUUID().slice(0, 8)}`)
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
      if (/\[RICH\]/.test(promptText(p.prompt))) {
        replyRichTurn(id, sessionId)
        return
      }
      const elicit = elicitationRequested(p.prompt)
      inFlightBySession.set(sessionId, {
        id: id!,
        sessionId,
        startedAt: Date.now(),
        chunks: 0,
        durationSec: durationSeconds(p.prompt),
        awaitingElicitation: elicit
      })
      if (elicit) {
        // Session-scoped form elicitation on the Devin wire: `sessionId`
        // sits flattened at the params top level (camelCase), `mode` is
        // the mode discriminator, `_meta` carries the allowOther flag.
        const elicitId = `elicit-${++nextElicitationId}`
        pendingElicitations.set(elicitId, { promptId: id!, sessionId })
        const line = JSON.stringify({
          jsonrpc: '2.0',
          id: elicitId,
          method: 'elicitation/create',
          params: {
            mode: 'form',
            sessionId,
            message: 'Which color should I use?',
            _meta: { 'cognition.ai/allowOther': true },
            requestedSchema: ELICIT_SCHEMA
          }
        })
        wireLog(`OUT: ${line}`)
        write(line)
      }
      if (promptText(p.prompt).includes('[USAGE]')) reportUsage(sessionId)
      const permissionDelaySec = permissionDelaySeconds(p.prompt)
      if (permissionDelaySec !== null) {
        if (permissionDelaySec === 0) requestPermission(sessionId)
        else setTimeout(() => requestPermission(sessionId), permissionDelaySec * 1000)
      }
      // Crash only when armed AND the marker is present: the host re-sends
      // the persisted open user turn verbatim on reopen (possibly on a
      // different session id), and a real crash is a one-time process
      // accident — the arm file is already consumed, so the replayed prompt
      // just runs a normal turn on the replacement agent.
      const crashAfterSec = crashAfterSeconds(p.prompt)
      if (crashAfterSec !== null && consumeCrashArm()) {
        // Die mid-turn without ever replying to session/prompt — the host
        // observes a dead child with an in-flight turn, same as a real crash.
        setTimeout(() => process.exit(1), Math.max(0, crashAfterSec * 1000))
      }
      if (promptText(p.prompt).includes('[DOCK]')) pushDock(sessionId)
      const asked = askKind(p.prompt)
      if (asked) {
        const askDelaySec = askDelaySeconds(p.prompt)
        if (askDelaySec === 0) ask(sessionId, asked)
        else setTimeout(() => ask(sessionId, asked), askDelaySec * 1000)
      }
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
        // A cancelled turn drops its held elicitation — a late client
        // response then finds no pending entry and is ignored.
        for (const [elicitId, pending] of pendingElicitations) {
          if (pending.sessionId === sessionId) pendingElicitations.delete(elicitId)
        }
      }
      // The server's CancelNotification carries no id — reply only when one
      // is present (a notification reply would be protocol noise).
      if (id !== undefined) respond(id, { stopReason: 'cancelled' })
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
      wireLog(`IN: ${line}`)
      handle(JSON.parse(line))
    } catch {
      /* ignore malformed */
    }
  }
})

process.on('exit', (code) => {
  wireLog(`EXIT code=${code}`)
})
process.on('uncaughtException', (err) => {
  wireLog(`UNCAUGHT ${err.stack ?? String(err)}`)
  process.exit(1)
})
