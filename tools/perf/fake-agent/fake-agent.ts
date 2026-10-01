/**
 * Seeded fake ACP agent (CAP-1) — the load source for every perf scenario.
 *
 * Speaks the Agent side of the ACP JSON-RPC protocol over stdio exactly as
 * the Termul Rust host expects it (verified wire shapes below; see the
 * code map in spec-perf-check-toolkit.md):
 *
 * 1. `initialize` (id) → `{ protocolVersion: 1, agentCapabilities: {...}, authMethods: [] }`
 * 2. `session/new` (id) → `{ sessionId }` (fresh id per call)
 * 3. `session/prompt` (id) → N × `session/update` notifications, then
 *    `{ stopReason: 'end_turn' }`
 * 4. `session/cancel` (notification) → respond the in-flight prompt with
 *    `stopReason: 'cancelled'`
 *
 * `session/update` notifications are tagged with the snake_case
 * `sessionUpdate` key (`agent_message_chunk`, `agent_thought_chunk`,
 * `tool_call`, `tool_call_update`, `plan`, `usage_update`) — the variants
 * the host's `emit_session_update` fans out to `acp:*` Tauri events.
 *
 * Determinism: a mulberry32 PRNG seeded from `PERF_AGENT_SEED` drives every
 * content choice. Same seed → byte-identical sessionUpdate sequence (the
 * runner records an event-sequence hash per run; CAP-1 acceptance). Time
 * pacing uses a fixed tick so the *content* sequence is independent of the
 * wall clock — only pacing differs between hosts.
 *
 * The app spawns this file via a StoredAgentConfig:
 *   { configId: 'custom-perfstub', command: 'bun', args: [<abs path to this file>], env: { ... } }
 * All knobs arrive as env vars because the ACP spawn path passes config.env
 * to the child process. CLI-flag equivalents (used by pty-flood and manual
 * debugging) are also accepted.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, JsonValue>
  result?: JsonValue
  error?: { code: number; message: string }
}

// ---------------------------------------------------------------------------
// Environment knobs (also accepted as CLI flags: --seed 42 --rate 20 ...)
// ---------------------------------------------------------------------------

export interface AgentKnobs {
  /** PRNG seed — same seed produces the identical event sequence. */
  seed: number
  /** Target sessionUpdate notifications per second. */
  rate: number
  /** Total stream duration in seconds (0 = stream until the prompt is cancelled). */
  durationSec: number
  /** Markdown fraction of agent_message_chunk text (rest is plain words). */
  markdownFraction: number
  /** Fraction of chunks that are agent_thought_chunk instead of message. */
  thoughtFraction: number
  /** Insert a tool_call every N events (0 disables). */
  toolCallEvery: number
  /** Insert a plan update every N events (0 disables). */
  planEvery: number
  /** Insert a usage_update every N events (0 disables). */
  usageEvery: number
  /** Approximate characters per agent_message_chunk. */
  chunkChars: number
  /** Delay before the first sessionUpdate (ms). */
  initialDelayMs: number
  /** Instance index disambiguates per-process seeds (runner sets it). */
  instance: number
  /**
   * `replay` mode: emit a recorded sessionUpdate fixture verbatim (path in
   * PERF_AGENT_REPLAY) for byte-identical streams, no PRNG.
   */
  replayPath: string | null
  /** Log every emitted update to stderr as JSONL (determinism debugging). */
  trace: boolean
  /**
   * Mock-realistic mode (PERF_AGENT_MOCK=1): tool calls carry real shapes —
   * `edit` with `{type:'diff'}` content, `execute` with rawOutput, `read`,
   * `search`, `think` — and each opens in_progress then completes via a
   * `tool_call_update` `toolUpdateDelay` events later. Long-form markdown
   * chunks (~900 chars) instead of the 120-char quick chunks. Reseeds the
   * RNG per sessionId so concurrent mock chats diverge.
   */
  mock: boolean
  /** Events between a tool_call open and its completing tool_call_update. */
  toolUpdateDelay: number
}

const DEFAULTS: AgentKnobs = {
  seed: 42,
  rate: 20,
  durationSec: 0,
  markdownFraction: 0.25,
  thoughtFraction: 0.1,
  toolCallEvery: 25,
  planEvery: 100,
  usageEvery: 50,
  chunkChars: 120,
  initialDelayMs: 50,
  instance: 0,
  replayPath: null,
  trace: false,
  mock: false,
  toolUpdateDelay: 4
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = Bun.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function parseFloatEnv(name: string, fallback: number): number {
  const raw = Bun.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Read knobs: env vars first, then `--key value` CLI flags override. */
export function readKnobs(argv: string[] = process.argv.slice(2)): AgentKnobs {
  const knobs: AgentKnobs = {
    seed: parseIntEnv('PERF_AGENT_SEED', DEFAULTS.seed),
    rate: parseFloatEnv('PERF_AGENT_RATE', DEFAULTS.rate),
    durationSec: parseFloatEnv('PERF_AGENT_DURATION', DEFAULTS.durationSec),
    markdownFraction: parseFloatEnv('PERF_AGENT_MARKDOWN_FRACTION', DEFAULTS.markdownFraction),
    thoughtFraction: parseFloatEnv('PERF_AGENT_THOUGHT_FRACTION', DEFAULTS.thoughtFraction),
    toolCallEvery: parseIntEnv('PERF_AGENT_TOOL_EVERY', DEFAULTS.toolCallEvery),
    planEvery: parseIntEnv('PERF_AGENT_PLAN_EVERY', DEFAULTS.planEvery),
    usageEvery: parseIntEnv('PERF_AGENT_USAGE_EVERY', DEFAULTS.usageEvery),
    chunkChars: parseIntEnv('PERF_AGENT_CHUNK_CHARS', DEFAULTS.chunkChars),
    initialDelayMs: parseIntEnv('PERF_AGENT_INITIAL_DELAY', DEFAULTS.initialDelayMs),
    instance: parseIntEnv('PERF_AGENT_INSTANCE', DEFAULTS.instance),
    replayPath: Bun.env.PERF_AGENT_REPLAY ?? null,
    trace: Bun.env.PERF_AGENT_TRACE === '1',
    mock: Bun.env.PERF_AGENT_MOCK === '1' || Bun.env.PERF_AGENT_MOCK === 'true',
    toolUpdateDelay: parseIntEnv('PERF_AGENT_TOOL_UPDATE_DELAY', DEFAULTS.toolUpdateDelay)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined) break
    switch (key) {
      case 'seed':
        knobs.seed = Number(next)
        break
      case 'rate':
        knobs.rate = Number(next)
        break
      case 'duration':
        knobs.durationSec = Number(next)
        break
      case 'markdown-fraction':
        knobs.markdownFraction = Number(next)
        break
      case 'thought-fraction':
        knobs.thoughtFraction = Number(next)
        break
      case 'tool-every':
        knobs.toolCallEvery = Number(next)
        break
      case 'plan-every':
        knobs.planEvery = Number(next)
        break
      case 'usage-every':
        knobs.usageEvery = Number(next)
        break
      case 'chunk-chars':
        knobs.chunkChars = Number(next)
        break
      case 'initial-delay':
        knobs.initialDelayMs = Number(next)
        break
      case 'instance':
        knobs.instance = Number(next)
        break
      case 'replay':
        knobs.replayPath = next
        break
      case 'trace':
        knobs.trace = next === '1' || next === 'true'
        break
    }
  }
  return knobs
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (deterministic across processes/hosts)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Content generators (seeded — never Math.random)
// ---------------------------------------------------------------------------

const WORDS = [
  'session',
  'stream',
  'render',
  'commit',
  'flush',
  'coalesce',
  'trim',
  'window',
  'heap',
  'frame',
  'jank',
  'longtask',
  'observer',
  'measure',
  'phase',
  'warmup',
  'sustained',
  'latency',
  'switch',
  'restore',
  'mount',
  'unmount',
  'virtualize',
  'transcript',
  'update',
  'chunk',
  'buffer',
  'pipeline',
  'store',
  'selector',
  'markdown',
  'parse',
  'sanitize',
  'code',
  'fence',
  'table',
  'list',
  'quote'
]

const CODE_SNIPPET = [
  '```ts',
  'const flushed = updates.map(apply);',
  'set((s) => ({ messages: { ...s.messages, [id]: list } }));',
  '```'
]

const TABLE_ROWS = [
  '| phase | ms |',
  '| --- | ---: |',
  '| warmup | 120 |',
  '| sustained | 4500 |',
  '| measure | 890 |'
]

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]
}

/** Seeded chunk of agent prose: plain words, occasionally markdown structure. */
function generateText(rng: () => number, targetChars: number, markdown: boolean): string {
  const words: string[] = []
  let len = 0
  while (len < targetChars) {
    const word = pick(rng, WORDS)
    words.push(word)
    len += word.length + 1
  }
  if (!markdown) return words.join(' ')
  // Markdown flavor chosen by the seed — exercises the streamdown parse path
  const flavor = Math.floor(rng() * 3)
  if (flavor === 0) return `**${words[0] ?? 'note'}** ${words.join(' ')}`
  if (flavor === 1) return `${words.join(' ')}\n${CODE_SNIPPET.join('\n')}`
  return `${words.join(' ')}\n${TABLE_ROWS.join('\n')}`
}

// ---------------------------------------------------------------------------
// FNV-1a hash — the event-sequence fingerprint (CAP-1 acceptance)
// ---------------------------------------------------------------------------

export function fnv1a(s: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** fnv1a as a numeric seed for mulberry32 (per-session mock divergence). */
function fnvSeed(seed: number, instance: number, sessionId: string): number {
  const hex = fnv1a(`${seed}:${instance}:${sessionId}`)
  return parseInt(hex, 16) >>> 0 || 1
}

interface InFlightPrompt {
  id: number | string
  sessionId: string
  timer: ReturnType<typeof setInterval> | null
  timeout: ReturnType<typeof setTimeout> | null
  eventIndex: number
  /** Running sequence hash across this prompt's updates. */
  hash: string
  emitted: number
  /** Mock mode: tool calls opened but not yet completed (events left). */
  openTools: Array<{ toolCallId: string; kind: string; remaining: number }>
  /** Mock mode: per-session RNG so concurrent chats diverge. */
  rng?: () => number
}

interface FakeAgent {
  knobs: AgentKnobs
  rng: () => number
  sessionCounter: number
  toolCounter: number
  inFlight: InFlightPrompt | null
  /** Set when session/cancel arrives; the tick loop drains and replies. */
  cancelled: boolean
  startedAt: number
}

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function notify(method: string, params: JsonValue): void {
  write(JSON.stringify({ jsonrpc: '2.0', method, params }))
}

function respond(id: number | string | undefined, result: JsonValue): void {
  if (id === undefined) return
  write(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

function respondError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return
  write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }))
}

// ---------------------------------------------------------------------------
// Mock-realistic content generators (PERF_AGENT_MOCK=1)
// ---------------------------------------------------------------------------

const MOCK_TOOLS: Array<{ kind: string; title: string }> = [
  { kind: 'read', title: 'Read file' },
  { kind: 'edit', title: 'Edit file' },
  { kind: 'execute', title: 'Run command' },
  { kind: 'search', title: 'Search codebase' },
  { kind: 'think', title: 'Plan next step' }
]

const MOCK_FILE_BODIES = [
  'export function applyUpdates(list, updates) {\n  for (const u of updates) {\n    list = merge(list, u)\n  }\n  return list\n}',
  'export const LIMIT = 8\nexport function pickDefault(entries) {\n  return entries.find((e) => e.ready) ?? entries[0] ?? null\n}',
  'async function drain(sessionId) {\n  const batch = pending.splice(0)\n  if (!batch.length) return\n  await commit(sessionId, batch)\n}'
]

/**
 * Mock-realistic update: tool calls carry the shapes real agents emit —
 * `edit` with `{type:'diff'}` content, `execute` with rawOutput, `read` /
 * `search` / `think` with locations — and complete via a `tool_call_update`
 * `toolUpdateDelay` events later. Interleaved with long-form markdown text.
 */
function buildMockUpdate(
  agent: FakeAgent,
  _sessionId: string
): { update: Record<string, JsonValue>; fingerprint: string } {
  const flight = agent.inFlight!
  const rng = flight.rng ?? agent.rng
  const knobs = agent.knobs
  const update: Record<string, JsonValue> = {}

  // 1) Complete a due tool call first — the app's tool-card state machine.
  const due = flight.openTools.find((t) => --t.remaining <= 0)
  if (due) {
    flight.openTools = flight.openTools.filter((t) => t !== due)
    update.sessionUpdate = 'tool_call_update'
    update.toolCallId = due.toolCallId
    update.update = {
      toolCallId: due.toolCallId,
      status: 'completed',
      ...(due.kind === 'execute' && {
        rawOutput: `ok\nexit 0\n${generateText(rng, 300, false)}`
      })
    }
  } else if (knobs.toolCallEvery > 0 && flight.eventIndex > 0 && flight.eventIndex % 7 === 0) {
    // 2) Open a new tool call every ~7 events (real session cadence).
    const spec = MOCK_TOOLS[Math.floor(rng() * MOCK_TOOLS.length)]
    const toolCallId = `tool-${agent.sessionCounter}-${agent.toolCounter++}`
    const path = `src/${pick(rng, WORDS)}.ts`
    update.sessionUpdate = 'tool_call'
    update.toolCallId = toolCallId
    update.toolCall = {
      toolCallId,
      title: spec.title,
      kind: spec.kind,
      status: 'in_progress',
      locations: [{ path, line: Math.floor(rng() * 200) }],
      rawInput: { path },
      ...(spec.kind === 'edit' && {
        content: [
          {
            type: 'diff',
            path,
            oldText: pick(rng, MOCK_FILE_BODIES).slice(0, 160),
            newText: `${pick(rng, MOCK_FILE_BODIES)}\n// perf: updated ${flight.eventIndex}`
          }
        ]
      }),
      ...(spec.kind === 'execute' && { rawInput: { command: 'bun test', cwd: '.' } })
    }
    flight.openTools.push({ toolCallId, kind: spec.kind, remaining: knobs.toolUpdateDelay })
  } else if (flight.eventIndex > 0 && flight.eventIndex % 41 === 0) {
    // 3) Usage update periodically (token counters in the header).
    update.sessionUpdate = 'usage_update'
    update.usage = {
      inputTokens: 12000 + Math.floor(rng() * 4000),
      outputTokens: 2400 + Math.floor(rng() * 1200)
    }
  } else if (rng() < knobs.thoughtFraction) {
    update.sessionUpdate = 'agent_thought_chunk'
    update.content = { type: 'text', text: generateText(rng, 200, false) }
  } else {
    // 4) Long-form text — ~900 chars, markdown-weighted (the real-world
    //    shape: agents write paragraphs, code fences, tables, lists).
    update.sessionUpdate = 'agent_message_chunk'
    update.content = { type: 'text', text: generateText(rng, 900, rng() < 0.6) }
  }

  const fingerprint = fnv1a(
    `${update.sessionUpdate}:${JSON.stringify(update.content ?? update.toolCall ?? update.update ?? update.usage ?? '')}`
  )
  flight.eventIndex++
  return { update, fingerprint }
}

// ---------------------------------------------------------------------------
// sessionUpdate stream
// ---------------------------------------------------------------------------

/**
 * Build the next sessionUpdate content for event index `i`.
 * Exported for the determinism smoke check in the CLI self-test.
 */
export function buildUpdate(
  agent: FakeAgent,
  sessionId: string
): { update: Record<string, JsonValue>; fingerprint: string } {
  if (agent.knobs.mock) return buildMockUpdate(agent, sessionId)
  const { rng, knobs } = agent
  const i = agent.inFlight ? agent.inFlight.eventIndex : 0
  const isThought = rng() < knobs.thoughtFraction
  const markdown = rng() < knobs.markdownFraction
  const text = generateText(rng, knobs.chunkChars, markdown)
  const update: Record<string, JsonValue> = {}
  if (isThought) {
    update.sessionUpdate = 'agent_thought_chunk'
    update.content = { type: 'text', text }
  } else if (knobs.toolCallEvery > 0 && i > 0 && i % knobs.toolCallEvery === 0) {
    const toolCallId = `tool-${agent.sessionCounter}-${agent.toolCounter++}`
    update.sessionUpdate = 'tool_call'
    update.toolCallId = toolCallId
    update.toolCall = {
      title: `Read ${pick(rng, WORDS)}`,
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: `src/${pick(rng, WORDS)}.ts` }
    }
  } else if (knobs.planEvery > 0 && i > 0 && i % knobs.planEvery === 0) {
    update.sessionUpdate = 'plan'
    update.plan = [
      { status: 'completed', text: 'Gather metrics' },
      { status: 'in_progress', text: 'Analyze frames' },
      { status: 'pending', text: 'Report' }
    ]
  } else if (knobs.usageEvery > 0 && i > 0 && i % knobs.usageEvery === 0) {
    update.sessionUpdate = 'usage_update'
    update.usage = {
      inputTokens: 1000 + Math.floor(rng() * 500),
      outputTokens: 500 + Math.floor(rng() * 300)
    }
  } else {
    update.sessionUpdate = 'agent_message_chunk'
    update.content = { type: 'text', text }
  }
  // Fingerprint the CONTENT (kind + payload) — the determinism contract is
  // over the emitted event sequence, not the wall-clock pacing.
  const fingerprint = fnv1a(
    `${update.sessionUpdate}:${JSON.stringify(update.content ?? update.toolCall ?? update.plan ?? update.usage ?? '')}`
  )
  agent.inFlight!.eventIndex++
  return { update, fingerprint }
}

function emitUpdate(agent: FakeAgent, sessionId: string): void {
  const { update, fingerprint } = buildUpdate(agent, sessionId)
  notify('session/update', { sessionId, update } as JsonValue)
  if (agent.inFlight) {
    agent.inFlight.hash = fnv1a(agent.inFlight.hash + fingerprint)
    agent.inFlight.emitted++
  }
  if (agent.knobs.trace) {
    console.error(JSON.stringify({ t: Date.now(), kind: update.sessionUpdate, fp: fingerprint }))
  }
}

function finishPrompt(agent: FakeAgent, stopReason: string): void {
  const prompt = agent.inFlight
  if (!prompt) return
  if (prompt.timer) clearInterval(prompt.timer)
  if (prompt.timeout) clearTimeout(prompt.timeout)
  agent.inFlight = null
  // Final trace line carries the sequence hash so the runner can cross-check.
  if (agent.knobs.trace) {
    console.error(
      JSON.stringify({ t: Date.now(), stopReason, hash: prompt.hash, events: prompt.emitted })
    )
  }
  respond(prompt.id, { stopReason } as JsonValue)
}

function startStream(agent: FakeAgent, id: number | string, sessionId: string): void {
  // One prompt at a time — the host rejects concurrent prompts per session
  // (ACP_TURN_IN_PROGRESS), so mirror that contract locally.
  if (agent.inFlight) {
    respondError(id, -32000, 'turn already in progress for this session')
    return
  }
  if (agent.knobs.replayPath) {
    replayFixture(agent, id, sessionId)
    return
  }
  const knobs = agent.knobs
  agent.inFlight = {
    id,
    sessionId,
    timer: null,
    timeout: null,
    eventIndex: 0,
    hash: fnv1a(`${knobs.seed}:${knobs.instance}:${sessionId}`),
    emitted: 0,
    openTools: [],
    // Mock mode: reseed per session so concurrent chats stream distinct
    // content — the incident shape is N different agents, not N copies.
    rng: knobs.mock ? mulberry32(fnvSeed(knobs.seed, knobs.instance, sessionId)) : undefined
  }
  const intervalMs = knobs.rate > 0 ? Math.max(1, Math.round(1000 / knobs.rate)) : 0
  const emitTick = () => {
    if (!agent.inFlight) return
    if (agent.cancelled) {
      agent.cancelled = false
      finishPrompt(agent, 'cancelled')
      return
    }
    if (
      knobs.durationSec > 0 &&
      agent.inFlight.emitted >= Math.ceil(knobs.rate * knobs.durationSec)
    ) {
      finishPrompt(agent, 'end_turn')
      return
    }
    emitUpdate(agent, sessionId)
  }
  const begin = () => {
    if (!agent.inFlight) return
    if (intervalMs > 0) {
      agent.inFlight.timer = setInterval(emitTick, intervalMs)
      // First event immediately so the app sees content without waiting a tick.
      emitTick()
    } else {
      // rate=0: emit nothing, hold the turn open (idle-load scenario).
      agent.inFlight.timeout = setInterval(() => emitTick(), 10_000) as ReturnType<
        typeof setTimeout
      >
    }
  }
  if (knobs.initialDelayMs > 0) {
    agent.inFlight.timeout = setTimeout(begin, knobs.initialDelayMs) as ReturnType<
      typeof setTimeout
    >
  } else {
    begin()
  }
}

/** Replay mode: stream a recorded sessionUpdate fixture verbatim. */
function replayFixture(agent: FakeAgent, id: number | string, sessionId: string): void {
  const path = agent.knobs.replayPath
  if (!path) {
    respondError(id, -32000, 'PERF_AGENT_REPLAY not set')
    return
  }
  let fixtures: Array<Record<string, JsonValue>> = []
  try {
    const raw = Bun.file(path)
    void raw.text().then((text) => {
      fixtures = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, JsonValue>)
      for (const update of fixtures) {
        notify('session/update', { sessionId, update } as JsonValue)
      }
      respond(id, { stopReason: 'end_turn' } as JsonValue)
    })
  } catch {
    respondError(id, -32000, `replay fixture unreadable: ${path}`)
  }
}

// ---------------------------------------------------------------------------
// Protocol dispatch
// ---------------------------------------------------------------------------

function handle(agent: FakeAgent, msg: JsonRpcMessage): void {
  const { id, method } = msg
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { list: false, resume: false, close: false }
      },
      authMethods: []
    })
    return
  }
  if (method === 'session/new') {
    agent.sessionCounter += 1
    respond(id, { sessionId: `perf-sess-${agent.sessionCounter}`, modes: [] })
    return
  }
  if (method === 'session/prompt') {
    const sessionId: unknown = msg.params?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      respondError(id, -32602, 'session/prompt requires a sessionId')
      return
    }
    if (id === undefined) return
    startStream(agent, id, sessionId)
    return
  }
  if (method === 'session/cancel') {
    // Notification: stop the in-flight turn (reply 'cancelled' on that prompt).
    if (agent.inFlight) {
      agent.cancelled = true
    }
    return
  }
  if (method === 'session/load' || method === 'session/resume') {
    // Not advertised (loadSession=false); answer method-not-found like the
    // stub so the host never silently waits on us.
    respondError(id, -32601, `method not found: ${method}`)
    return
  }
  // Unknown requests → method-not-found; notifications and responses ignored.
  if (id !== undefined && method !== undefined) {
    respondError(id, -32601, `method not found: ${method}`)
  }
}

function parseMessage(line: string): JsonRpcMessage | null {
  const parsed: unknown = JSON.parse(line)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as JsonRpcMessage
  }
  return null
}

// ---------------------------------------------------------------------------
// Entry — stdio loop
// ---------------------------------------------------------------------------

export function createAgent(knobs: AgentKnobs): FakeAgent {
  return {
    knobs,
    // Instance-offset seed so K concurrent processes with the same base seed
    // still deterministically diverge (seed=42, instance=i).
    rng: mulberry32((knobs.seed ^ (knobs.instance * 0x9e3779b9)) >>> 0),
    sessionCounter: 0,
    toolCounter: 0,
    inFlight: null,
    cancelled: false,
    startedAt: Date.now()
  }
}

function readMessages(agent: FakeAgent): Promise<void> {
  let buf = ''
  const dec = new TextDecoder()
  const stdin = Bun.stdin.stream()
  const loop = async (): Promise<void> => {
    for await (const chunk of stdin) {
      const text = typeof chunk === 'string' ? chunk : dec.decode(chunk)
      buf += text
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line.length === 0) {
          idx = buf.indexOf('\n')
          continue
        }
        let msg: JsonRpcMessage | null = null
        try {
          msg = parseMessage(line)
        } catch {
          idx = buf.indexOf('\n')
          continue
        }
        if (msg === null) {
          idx = buf.indexOf('\n')
          continue
        }
        handle(agent, msg)
        idx = buf.indexOf('\n')
      }
    }
  }
  return loop()
}

// CLI self-test: `bun tools/perf/fake-agent/fake-agent.ts --self-test`
// Verifies PRNG determinism + update-shape coverage WITHOUT stdio.
export function selfTest(): void {
  const knobs = { ...DEFAULTS, seed: 7, toolCallEvery: 5, planEvery: 7, usageEvery: 6 }
  const run = (): string[] => {
    const agent = createAgent(knobs)
    agent.inFlight = {
      id: 1,
      sessionId: 's',
      timer: null,
      timeout: null,
      eventIndex: 0,
      hash: '',
      emitted: 0,
      openTools: []
    }
    const kinds: string[] = []
    for (let i = 0; i < 24; i++) {
      kinds.push(buildUpdate(agent, 's').update.sessionUpdate as string)
    }
    return kinds
  }
  const a = run()
  const b = run()
  if (a.join(',') !== b.join(',')) throw new Error('self-test: sequence not deterministic')
  const need = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'plan', 'usage_update']
  for (const kind of need) {
    if (!a.includes(kind)) throw new Error(`self-test: missing variant ${kind}`)
  }
  console.log('fake-agent self-test ok:', a.length, 'updates; kinds:', [...new Set(a)].join(' '))
}

// --- main (skip when imported for types/self-test) ---
const isMain = import.meta.main && !process.argv.includes('--self-test')
if (isMain) {
  const agent = createAgent(readKnobs())
  readMessages(agent).catch((e: unknown) => {
    console.error('fake agent reader failed:', e)
    process.exit(1)
  })
  // Safety: never linger forever if the host dies without closing stdin
  // (stdin EOF normally unblocks the loop; this catches pathological cases).
  const watchdog = setTimeout(() => process.exit(0), 24 * 60 * 60 * 1000)
  watchdog.unref?.()
} else if (import.meta.main && process.argv.includes('--self-test')) {
  selfTest()
}
