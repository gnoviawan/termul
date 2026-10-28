/** Clears the shell line editor. No command text. */
export const CLEAR_LINE_SEQUENCE = '\u001b[99;1~'

/** Restores the shell prompt. Distinct from the clear-line sequence. */
export const RESTORE_PROMPT_SEQUENCE = '\u001b[99;2~'

/** Submit and completion outcomes. Serde names are the variant names. */
export const SESSION_RPC_RESULTS = ['Accepted', 'PreWrite', 'Partial', 'NotStarted'] as const

export type SessionRpcResult = (typeof SESSION_RPC_RESULTS)[number]

export function serializeSessionRpcResult(result: SessionRpcResult): string {
  return JSON.stringify(result)
}

/** Lifecycle frame names. Completion is a result struct, not one of these. */
export const SESSION_FRAME_NAMES = [
  'InitShell',
  'PromptReady',
  'CommandStarted',
  'CommandFinished'
] as const

export type SessionFrameName = (typeof SESSION_FRAME_NAMES)[number]

/** Validity fields plus the completer output. Not a mode frame. */
export interface CompletionResult {
  session_id: string
  nonce: string
  request_id: string
  buffer_revision: number
  cursor: number
  prompt_generation: number
  cwd: string
  output: string
}

export type SessionFrame =
  | { type: 'InitShell'; session_id?: string; nonce?: string }
  | {
      type: 'PromptReady'
      nonce?: string
      prompt_generation?: number
      line_empty?: boolean
      prompt_suppressed?: boolean
      cwd?: string
    }
  | { type: 'CommandStarted'; nonce?: string }
  | { type: 'CommandFinished'; nonce?: string; exit_code?: number }
  | { type: 'Completion'; result: CompletionResult }

export type SessionParse = { ok: true; frame: SessionFrame } | { ok: false; reason: string }

const COMPLETION_FIELDS = [
  'session_id',
  'nonce',
  'request_id',
  'buffer_revision',
  'cursor',
  'prompt_generation',
  'cwd',
  'output'
] as const

function asRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === 'string') {
    try {
      return asRecord(JSON.parse(payload) as unknown)
    } catch {
      return null
    }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readCompletion(value: Record<string, unknown>): CompletionResult | null {
  for (const field of COMPLETION_FIELDS) {
    if (value[field] === undefined) return null
  }
  const sessionId = readString(value.session_id)
  const nonce = readString(value.nonce)
  const requestId = readString(value.request_id)
  const bufferRevision = readNumber(value.buffer_revision)
  const cursor = readNumber(value.cursor)
  const promptGeneration = readNumber(value.prompt_generation)
  const cwd = readString(value.cwd)
  const output = readString(value.output)
  if (
    sessionId === undefined ||
    nonce === undefined ||
    requestId === undefined ||
    bufferRevision === undefined ||
    cursor === undefined ||
    promptGeneration === undefined ||
    cwd === undefined ||
    output === undefined
  ) {
    return null
  }
  return {
    session_id: sessionId,
    nonce,
    request_id: requestId,
    buffer_revision: bufferRevision,
    cursor,
    prompt_generation: promptGeneration,
    cwd,
    output
  }
}

const LIFECYCLE_FRAMES = new Set<string>(SESSION_FRAME_NAMES)

function readBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readPromptReady(
  value: Record<string, unknown>
): Extract<SessionFrame, { type: 'PromptReady' }> | null {
  const nonce = readString(value.nonce)
  const promptGeneration = readNumber(value.prompt_generation)
  const lineEmpty = readBool(value.line_empty)
  const promptSuppressed = readBool(value.prompt_suppressed)
  const cwd = readString(value.cwd)
  if (
    nonce === undefined ||
    promptGeneration === undefined ||
    lineEmpty === undefined ||
    promptSuppressed === undefined ||
    cwd === undefined
  ) {
    return null
  }
  return {
    type: 'PromptReady',
    nonce,
    prompt_generation: promptGeneration,
    line_empty: lineEmpty,
    prompt_suppressed: promptSuppressed,
    cwd
  }
}

function frameNonce(frame: SessionFrame): string | undefined {
  if (frame.type === 'Completion') return frame.result.nonce
  return frame.nonce
}

function parsePayload(payload: unknown): SessionParse {
  const value = asRecord(payload)
  if (!value || typeof value.type !== 'string') return { ok: false, reason: 'invalid' }

  if (value.type === 'Completion') {
    const result = readCompletion(value)
    if (!result) return { ok: false, reason: 'invalid' }
    return { ok: true, frame: { type: 'Completion', result } }
  }

  if (!LIFECYCLE_FRAMES.has(value.type)) return { ok: false, reason: 'invalid' }

  if (value.type === 'InitShell') {
    const sessionId = readString(value.session_id)
    const nonce = readString(value.nonce)
    if (sessionId === undefined || nonce === undefined) return { ok: false, reason: 'invalid' }
    return { ok: true, frame: { type: 'InitShell', session_id: sessionId, nonce } }
  }
  if (value.type === 'PromptReady') {
    const frame = readPromptReady(value)
    if (!frame) return { ok: false, reason: 'invalid' }
    return { ok: true, frame }
  }
  if (value.type === 'CommandStarted') {
    const nonce = readString(value.nonce)
    if ('nonce' in value && nonce === undefined) return { ok: false, reason: 'invalid' }
    return {
      ok: true,
      frame: { type: 'CommandStarted', ...(nonce === undefined ? {} : { nonce }) }
    }
  }
  const nonce = readString(value.nonce)
  if ('nonce' in value && nonce === undefined) return { ok: false, reason: 'invalid' }
  const exitCode = readNumber(value.exit_code)
  return {
    ok: true,
    frame: {
      type: 'CommandFinished',
      ...(nonce === undefined ? {} : { nonce }),
      ...(exitCode === undefined ? {} : { exit_code: exitCode })
    }
  }
}

/**
 * Parse a session payload. A caller-supplied nonce that does not match the
 * frame is rejected. Rejection is not a mode signal and does not choose a mode.
 */
export function parseSessionFrame(payload: unknown, registeredNonce?: string): SessionParse {
  const parsed = parsePayload(payload)
  if (!parsed.ok || registeredNonce === undefined) return parsed
  if (frameNonce(parsed.frame) !== registeredNonce) {
    return { ok: false, reason: 'nonce_mismatch' }
  }
  return parsed
}
