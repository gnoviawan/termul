import { isProviderErrorCode, type ProviderErrorCode } from '@shared/types/web-protocol.types'
import type { AgentConfig, AuthMethod } from '@/lib/acp-api'
import { DEFINITE_SPAWN_REJECTIONS } from '@/lib/acp-transport/tauri-verdicts'

// Match only explicit process-spawn / executable-launch failures. Generic
// "not found" / "cannot find" are intentionally excluded so messages about a
// missing API key, credential, or session are not misclassified as a spawn
// error (and rewritten by `formatAcpSpawnError` into spawn guidance).
const ENOENT_PATTERN =
  /enoent|no such file|program not found|command not found|spawn.*fail|failed to spawn/i

// The Rust resolver's own wording (`pty/manager/resolve.rs`): `program not
// found or not executable: <path>`, `program not found on PATH: <name>`, and
// the `Agent program not found[ on PATH]: <name>` variants. Group 1 is the
// file it names.
const RESOLVER_FAILURE_PATTERN = /program not found(?: or not executable| on PATH)?: (.+)$/i

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
  // The desktop host's `ACP_AGENT_UNAVAILABLE:` / `ACP_INVALID_AGENT_CONFIG:`
  // transport prefixes are not user-visible text.
  const message = definiteSpawnRejectionMessage(raw)
  if (!ENOENT_PATTERN.test(message)) return message

  // Resolver-level failures name the file they could not prepare (e.g.
  // `program not found or not executable: C:\…\npm\claude.cmd`). When that
  // file is not the spawned command — managed `claude-acp` runs `node` while
  // its *pre-spawn CLI probe* is the piece that failed — rewriting against
  // `config.command` would blame the wrong binary, so the resolver's own
  // wording stays. Any other message (an OS error such as `No such file or
  // directory (os error 2)`) names no such file and is rewritten.
  const namedPath = RESOLVER_FAILURE_PATTERN.exec(message)?.[1]?.trim().replace(/^"|"$/g, '')
  if (namedPath) {
    const namedBase = namedPath.split(/[\\/]/).filter(Boolean).pop()
    const commandBase = config?.command?.split(/[\\/]/).pop()
    if (namedBase && commandBase && namedBase.toLowerCase() !== commandBase.toLowerCase()) {
      return message
    }
  }

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
 * - `provider`    the upstream provider refused the call (quota / usage limit,
 *                 session limit, rejected request); the host names which one
 *                 with a stable code, so no message wording is parsed.
 * - `timeout`     initialize / `session/new` timed out (agent is alive but slow
 *                 or wedged).
 * - `unknown`     anything else; the diagnostic is surfaced verbatim.
 */
export type SetupErrorCategory =
  | 'multi-auth'
  | 'spawn'
  | 'transport'
  | 'auth'
  | 'provider'
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
  /**
   * The host rejected the spawn deterministically (`agent_unavailable` /
   * `invalid_agent_config`, AD-5): silent re-prepares must not retry it; only
   * a user-initiated Retry may.
   */
  definite?: boolean
  /** The host's stable provider failure code (`category: 'provider'` only). */
  providerCode?: ProviderErrorCode
}

/** Short, actionable label for each setup-failure category. */
export const SETUP_ERROR_LABELS: Record<SetupErrorCategory, string> = {
  'multi-auth': 'Multiple sign-in methods',
  spawn: 'Agent unavailable',
  transport: 'Agent connection lost',
  auth: 'Authentication required',
  provider: 'Provider refused the request',
  timeout: 'Session setup timed out',
  unknown: 'Setup failed'
}

/** Short label per provider failure code. */
export const PROVIDER_ERROR_LABELS: Record<ProviderErrorCode, string> = {
  provider_quota_exceeded: 'Usage limit reached',
  provider_session_limit: 'Session limit reached',
  provider_request_rejected: 'Provider rejected the request'
}

/** Plain-language explanation per provider failure code. */
export const PROVIDER_ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  provider_quota_exceeded:
    "The provider's usage limit was reached. Wait for it to reset or check your plan, then try again.",
  provider_session_limit:
    "The provider's session limit was reached. Wait for it to reset, then try again.",
  provider_request_rejected:
    'The provider rejected the request. Check the model and account settings, then try again.'
}

/**
 * The text a person reads for a provider failure: the plain-language message
 * for its code, followed by the provider's own wording (it may name when the
 * limit resets) when that adds anything.
 */
export function describeProviderFailure(code: ProviderErrorCode, own: string): string {
  const plain = PROVIDER_ERROR_MESSAGES[code]
  const trimmed = own.trim()
  return trimmed && trimmed !== code ? `${plain} (${trimmed})` : plain
}

/**
 * The host's stable provider failure code on a failure, however it arrived: the
 * `/ws` `err.code` / `AcpTransportError.code`, or a serialized `{ code }`
 * object. `undefined` for every other value.
 */
export function providerCodeOf(raw: unknown): ProviderErrorCode | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const code = (raw as { code?: unknown }).code
  return isProviderErrorCode(code) ? code : undefined
}

/** Marker code carried by {@link AmbiguousAuthError} so it survives serialization. */
export const AMBIGUOUS_AUTH_CODE = 'ACP_MULTI_AUTH'
/**
 * Additive wire code for "the agent requires sign-in before `session/new` can
 * proceed" (carried on `AcpTransportError.code`; story 7 emits it, older hosts
 * never do). The pre-code fallback is the `ACP_AUTH_REQUIRED` message prefix.
 */
export const AGENT_AUTH_REQUIRED_CODE = 'agent_auth_required'
export const AGENT_AUTH_REQUIRED_PREFIX = 'ACP_AUTH_REQUIRED'

/**
 * True when a launch failure is the explicit auth-required signal: either the
 * additive `agent_auth_required` transport code or a message carrying the
 * `ACP_AUTH_REQUIRED` prefix. Tolerant by design — old servers that send
 * neither fall through to the generic AUTH_PATTERN classification.
 */
export function isAgentAuthRequiredError(raw: unknown): boolean {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { code?: unknown }).code === AGENT_AUTH_REQUIRED_CODE
  ) {
    return true
  }
  const message = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : ''
  return message.startsWith(AGENT_AUTH_REQUIRED_PREFIX)
}

/**
 * The host rejected a spawn deterministically (AD-5): the agent binary is
 * missing / cannot start (`agent_unavailable`) or the config is unusable
 * (`invalid_agent_config`). `/ws` carries the stable code; the Tauri `invoke`
 * path carries the same verdict as a message prefix. Retrying the same request
 * cannot succeed, so no code path may re-issue it automatically — only a user
 * action (a new intent) may try again.
 */
export function isDefiniteSpawnRejection(raw: unknown): boolean {
  if (typeof raw === 'object' && raw !== null) {
    const code = (raw as { code?: unknown }).code
    if (DEFINITE_SPAWN_REJECTIONS.some(([known]) => known === code)) return true
  }
  const message = rawErrorMessage(raw)
  return DEFINITE_SPAWN_REJECTIONS.some(([, prefix]) => message.startsWith(`${prefix}: `))
}

/**
 * The text of an error however it arrived: an `Error`, a bare string (Tauri), or
 * a serialized `{ code, message }` object (it must read as its message, never
 * `[object Object]`).
 */
function rawErrorMessage(raw: unknown): string {
  if (raw instanceof Error) return raw.message
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const own = (raw as { message?: unknown }).message
    if (typeof own === 'string') return own
  }
  return String(raw)
}

/** The human message of a definite spawn rejection, without the transport prefix. */
function definiteSpawnRejectionMessage(raw: unknown): string {
  const message = rawErrorMessage(raw)
  for (const [, prefix] of DEFINITE_SPAWN_REJECTIONS) {
    if (message.startsWith(`${prefix}: `)) return message.slice(prefix.length + 2)
  }
  return message
}

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
        'Termul does not choose one automatically; pick one of the methods below to sign in.'
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
 *   multi-auth → agent-auth-required → definite spawn rejection → provider
 *   code → spawn (ENOENT) → transport → auth → timeout → unknown.
 *
 * The explicit `agent_auth_required` wire code / `ACP_AUTH_REQUIRED` message
 * prefix is checked BEFORE the wording heuristics: an auth-required reply may
 * carry transport-sounding detail text (e.g. "create_session rejected:
 * transport closed") and must still surface as the actionable sign-in
 * category.
 *
 * An explicit server error code is checked right after multi-auth: the code is
 * authoritative, so it wins even when the message carries no auth wording.
 * Transport is checked before auth (so connection/stream wording wins when both
 * are present) and before timeout (so "connection timed out" evicts rather than
 * being treated as a benign slow setup). The category is always derived from the
 * RAW error message; `spawn` rewrites
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
  // The explicit auth-required signal wins over the wording heuristics below
  // (an `agent_auth_required` reply may carry transport-sounding detail text).
  if (isAgentAuthRequiredError(raw)) {
    // Plain objects (post-serialization) carry the message on a property; when
    // it is absent on a non-Error value, String(raw) is the useless
    // "[object Object]" — fall back to the code itself.
    const own =
      typeof raw === 'object' && raw !== null && 'message' in raw ? raw.message : undefined
    const detail =
      typeof own === 'string'
        ? own
        : raw instanceof Error || typeof raw === 'string'
          ? message
          : AGENT_AUTH_REQUIRED_CODE
    return { category: 'auth', label: SETUP_ERROR_LABELS.auth, detail }
  }
  // A definite host rejection (AD-5) is authoritative: it is a spawn failure
  // whatever the wording, and it must never read as transport/auth (those
  // categories evict and re-authenticate for a retry that cannot succeed).
  if (isDefiniteSpawnRejection(raw)) {
    return {
      category: 'spawn',
      label: SETUP_ERROR_LABELS.spawn,
      detail: formatAcpSpawnError(definiteSpawnRejectionMessage(raw), config),
      definite: true
    }
  }
  // The host's provider code is authoritative too: a quota or session limit
  // may carry any wording (including words the heuristics below read as auth
  // or transport), and it must never evict the process or ask to sign in.
  const providerCode = providerCodeOf(raw)
  if (providerCode) {
    return {
      category: 'provider',
      label: PROVIDER_ERROR_LABELS[providerCode],
      detail: describeProviderFailure(providerCode, rawErrorMessage(raw)),
      providerCode
    }
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
