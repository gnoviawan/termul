import type { AgentConfig, AuthMethod } from '@/lib/acp-api'

// Match only explicit process-spawn / executable-launch failures. Generic
// "not found" / "cannot find" are intentionally excluded so messages about a
// missing API key, credential, or session are not misclassified as a spawn
// error (and rewritten by `formatAcpSpawnError` into spawn guidance).
const ENOENT_PATTERN =
  /enoent|no such file|program not found|command not found|spawn.*fail|failed to spawn/i

/** Server/client rate-limit or HTTP/2 "slow down" (e.g. NGHTTP2_ENHANCE_YOUR_CALM). */
const RATE_LIMIT_PATTERN =
  /ENHANCE_YOUR_CALM|enhance[\s_-]?your[\s_-]?calm|rate[\s_-]?limit|too many requests|\b429\b/i

/**
 * Mid-turn stream / connection drops. Checked after rate-limit so
 * `Stream closed … NGHTTP2_ENHANCE_YOUR_CALM` maps to the rate-limit copy.
 */
const STREAM_INTERRUPT_PATTERN =
  /RetriableError|NGHTTP2_|destroyed|stream (?:closed|ended|destroyed|error)|broken pipe|e?pipe\b|econnreset|econnrefused|disconnected|connection (?:closed|lost|reset|refused|aborted)|connection.*timed out|agent thread (?:is no longer running|dropped)/i

export const ACP_RATE_LIMIT_MESSAGE =
  'Connection was rate-limited by the agent service. Wait a moment, then retry.'

export const ACP_STREAM_INTERRUPT_MESSAGE =
  'Agent connection was interrupted. Wait a moment, then retry.'

/**
 * Turn a raw agent turn/setup error into a user-facing message. Known
 * rate-limit and stream/connection failures are rewritten into short
 * actionable copy; everything else is passed through verbatim.
 */
export function formatAcpAgentError(raw: unknown): string {
  const message = raw instanceof Error ? raw.message : String(raw)
  if (RATE_LIMIT_PATTERN.test(message)) return ACP_RATE_LIMIT_MESSAGE
  if (STREAM_INTERRUPT_PATTERN.test(message)) return ACP_STREAM_INTERRUPT_MESSAGE
  return message
}

/**
 * Turn a raw spawn/setup error into a user-facing message. Only ENOENT-style
 * failures (a missing/unresolvable command) are rewritten into actionable
 * guidance; every other message is passed through verbatim so the underlying
 * diagnostic is preserved.
 */
export function formatAcpSpawnError(raw: unknown, config?: Pick<AgentConfig, 'command'>): string {
  const message = raw instanceof Error ? raw.message : String(raw)
  if (!ENOENT_PATTERN.test(message)) return message

  if (config?.command === 'npx') {
    return 'Could not run npx. Install Node.js and ensure npx is on your PATH, then try again.'
  }
  if (config?.command === 'uvx') {
    return 'Could not run uvx. Install uv and ensure uvx is on your PATH, then try again.'
  }
  if (config?.command) {
    return `Could not start "${config.command}". Check that the binary exists and is on your PATH.`
  }
  return 'Could not start the ACP agent. Check that the command exists and is on your PATH.'
}

/**
 * Stable, deterministic categories for an ACP provider-setup failure. The
 * renderer maps each to a distinct actionable label; only genuine model-state
 * problems use "Model unavailable" (handled by the launcher, not here).
 *
 * - `multi-auth`  the agent advertised more than one auth method and none is a
 *                 single unambiguous default; Termul never silently picks one.
 * - `spawn`       the agent binary could not be launched (ENOENT-style).
 * - `transport`   the connection/stream was destroyed or refused; the process
 *                 must be evicted before any retry (it cannot be reused).
 * - `auth`        the provider requires the user to complete authentication.
 * - `timeout`     initialize / `session/new` timed out (agent is alive but slow
 *                 or wedged).
 * - `unknown`     anything else; the diagnostic is surfaced verbatim.
 */
export type SetupErrorCategory =
  | 'multi-auth'
  | 'spawn'
  | 'transport'
  | 'auth'
  | 'timeout'
  | 'unknown'

/**
 * A classified provider-setup failure, consumed by the launcher: `label` is the
 * short pill/heading text, `detail` is the full (already user-formatted)
 * diagnostic. Classification is derived from the RAW error; `detail` may be a
 * friendlier rewrite (e.g. ENOENT guidance).
 */
export interface PrepareChatError {
  category: SetupErrorCategory
  label: string
  detail: string
}

/** Short, actionable label for each setup-failure category. */
export const SETUP_ERROR_LABELS: Record<SetupErrorCategory, string> = {
  'multi-auth': 'Multiple sign-in methods',
  spawn: 'Agent unavailable',
  transport: 'Agent connection lost',
  auth: 'Authentication required',
  timeout: 'Session setup timed out',
  unknown: 'Setup failed'
}

/** Marker code carried by {@link AmbiguousAuthError} so it survives serialization. */
export const AMBIGUOUS_AUTH_CODE = 'ACP_MULTI_AUTH'

/**
 * Thrown when an agent advertises more than one authentication method and none
 * is a single unambiguous default. Termul must never silently choose a method,
 * so this surfaces as an actionable `multi-auth` failure that lists the method
 * names. Carries a stable `code` so the classifier recognizes it even after the
 * error crosses an async/String boundary.
 */
export class AmbiguousAuthError extends Error {
  readonly code = AMBIGUOUS_AUTH_CODE
  readonly methods: AuthMethod[]

  constructor(methods: AuthMethod[]) {
    const names = methods.map((m) => m.name).join(', ')
    super(
      `This agent advertises multiple sign-in methods (${names}). ` +
        'Termul does not choose one automatically; select a single-method agent or configure the provider directly.'
    )
    this.name = 'AmbiguousAuthError'
    this.methods = methods
  }
}

/** True when `e` is an ambiguous-auth failure (instance or marker-carrying value). */
export function isAmbiguousAuthError(e: unknown): boolean {
  if (e instanceof AmbiguousAuthError) return true
  return (
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === AMBIGUOUS_AUTH_CODE
  )
}

// Connection/stream failures. A destroyed stream, refused/reset/closed
// connection, or a dead driver channel means the process cannot be reused and
// must be evicted before retry. "connection timed out" is intentionally matched
// here (not by TIMEOUT) so a transport-level timeout evicts the process.
const TRANSPORT_PATTERN =
  /destroyed|broken pipe|e?pipe\b|econnreset|econnrefused|disconnected|connection (?:closed|lost|reset|refused|aborted)|connection.*timed out|stream (?:closed|ended|destroyed|error)|transport|agent thread (?:is no longer running|dropped)/i

// Provider authentication is required / failed. Checked AFTER transport so a
// message carrying both connection and auth wording is treated as transport
// (the process is broken and must be evicted).
const AUTH_PATTERN =
  /auth|login|sign[\s-]?in|credential|unauthori[sz]|api[\s-]?key|not logged in|logged out|\b401\b|\b403\b|forbidden/i

// A slow or wedged (but alive) agent. TRANSPORT already claimed
// connection-level timeouts, so this only matches plain initialize / session
// timeouts where the process is still usable.
const TIMEOUT_PATTERN = /timed out|timeout/i

/**
 * Classify a provider-setup failure into a stable {@link PrepareChatError}.
 *
 * Classification is deterministic and order-sensitive (P4):
 *   multi-auth → spawn (ENOENT) → transport → auth → timeout → unknown.
 *
 * Transport is checked before auth (so connection/stream wording wins when both
 * are present) and before timeout (so "connection timed out" evicts rather than
 * The category is always derived from the RAW error message; `spawn` rewrites
 * `detail` via {@link formatAcpSpawnError}, and `transport` / `unknown` run
 * {@link formatAcpAgentError} so rate-limit and stream drops stay actionable.
 */
export function classifySetupError(
  raw: unknown,
  config?: Pick<AgentConfig, 'command'>
): PrepareChatError {
  const message = raw instanceof Error ? raw.message : String(raw)

  if (isAmbiguousAuthError(raw)) {
    return { category: 'multi-auth', label: SETUP_ERROR_LABELS['multi-auth'], detail: message }
  }
  if (ENOENT_PATTERN.test(message)) {
    return {
      category: 'spawn',
      label: SETUP_ERROR_LABELS.spawn,
      detail: formatAcpSpawnError(raw, config)
    }
  }
  if (TRANSPORT_PATTERN.test(message)) {
    return {
      category: 'transport',
      label: SETUP_ERROR_LABELS.transport,
      detail: formatAcpAgentError(raw)
    }
  }
  if (AUTH_PATTERN.test(message)) {
    return { category: 'auth', label: SETUP_ERROR_LABELS.auth, detail: message }
  }
  if (TIMEOUT_PATTERN.test(message)) {
    return { category: 'timeout', label: SETUP_ERROR_LABELS.timeout, detail: message }
  }
  return {
    category: 'unknown',
    label: SETUP_ERROR_LABELS.unknown,
    detail: formatAcpAgentError(raw)
  }
}
