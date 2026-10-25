/**
 * Agent browser consent tickets and Stop, on every client.
 *
 * The host raises browser consent as an ordinary `acp:permission_request`
 * whose request id is `host:<uuid>` and whose `_meta.termul.origin_kind` is
 * `"browser"`. The desktop answers through its `main`-webview command; a
 * remote client answers through `/ws respond_permission`, which the host
 * resolves only for an authenticated client of the session. Stop has the
 * same two carriers.
 */

import { getAcpTransport } from './acp-transport'
import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'

export const HOST_TICKET_PREFIX = 'host:'

/** The host refuses answers this soon after the prompt is shown. */
export const CONSENT_ANSWER_FLOOR_MS = 750

export type BrowserConsentOptionId = 'allow_session' | 'allow_project' | 'deny'

export type BrowserConsentAction =
  | 'navigate'
  | 'local_network'
  | 'password_submit'
  | 'payment_submit'
  | 'upload'
  | 'download'
  | 'tainted_exfil'

export interface BrowserConsentTicket {
  requestId: string
  sessionId: string
  /** Host-canonical origin, e.g. `https://example.com`. */
  origin: string
  /** Full target URL with a long query cut by the host. */
  targetUrl: string
  /** Byte length of the uncut target URL. */
  targetUrlBytes: number
  action: BrowserConsentAction
  /** Agent-supplied intent: shown as such, never trusted. */
  element?: string
  /** For an upload, the host-checked file it sends: base name and size. */
  file?: { name: string; bytes: number }
  profile: 'global' | 'ephemeral'
  options: BrowserConsentOptionId[]
}

const OPTION_IDS: readonly BrowserConsentOptionId[] = ['allow_session', 'allow_project', 'deny']
const ACTIONS: readonly BrowserConsentAction[] = [
  'navigate',
  'local_network',
  'password_submit',
  'payment_submit',
  'upload',
  'download',
  'tainted_exfil'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The browser consent ticket a permission request carries, or `null` for an
 * agent's own permission request. Only host-namespaced ids qualify: an agent
 * cannot mint one, whatever `_meta` it sends.
 */
export function parseBrowserConsentTicket(event: unknown): BrowserConsentTicket | null {
  if (!isRecord(event)) return null
  const { requestId, sessionId, options, _meta: meta } = event
  if (typeof requestId !== 'string' || !requestId.startsWith(HOST_TICKET_PREFIX)) return null
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const termul = isRecord(meta) && isRecord(meta.termul) ? meta.termul : null
  if (termul?.origin_kind !== 'browser' || !isRecord(termul.browser)) return null
  const browser = termul.browser
  if (typeof browser.origin !== 'string' || typeof browser.targetUrl !== 'string') return null
  const action = ACTIONS.find((a) => a === browser.action) ?? 'navigate'
  const offered = Array.isArray(options)
    ? options.flatMap((o) => {
        const id = isRecord(o) ? OPTION_IDS.find((known) => known === o.optionId) : undefined
        return id ? [id] : []
      })
    : []
  return {
    requestId,
    sessionId,
    origin: browser.origin,
    targetUrl: browser.targetUrl,
    targetUrlBytes:
      typeof browser.targetUrlBytes === 'number'
        ? browser.targetUrlBytes
        : browser.targetUrl.length,
    action,
    element: typeof browser.element === 'string' ? browser.element : undefined,
    file:
      isRecord(browser.file) &&
      typeof browser.file.name === 'string' &&
      typeof browser.file.bytes === 'number'
        ? { name: browser.file.name, bytes: browser.file.bytes }
        : undefined,
    profile: browser.profile === 'ephemeral' ? 'ephemeral' : 'global',
    options: offered.length > 0 ? offered : [...OPTION_IDS]
  }
}

/** Why an answer did not land; `stale` covers answered-elsewhere and expired. */
export type BrowserTicketAnswerResult = 'ok' | 'stale' | 'too_early' | 'refused'

function classify(code: string | undefined): BrowserTicketAnswerResult {
  switch (code) {
    case 'TICKET_NOT_FOUND':
    case 'TICKET_ALREADY_RESOLVED':
    case 'stale':
    case 'already_resolved':
      return 'stale'
    case 'TICKET_TOO_EARLY':
    case 'rate_limited':
      return 'too_early'
    default:
      return 'refused'
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

/** Answer a browser consent ticket. `agentId` only fills the `/ws` payload. */
export async function answerBrowserConsent(
  ticket: Pick<BrowserConsentTicket, 'requestId'>,
  optionId: BrowserConsentOptionId,
  agentId = ''
): Promise<BrowserTicketAnswerResult> {
  if (isTauriContext()) {
    const result = await invokeIpc<null>('browser_ticket_respond', {
      requestId: ticket.requestId,
      optionId
    })
    return result.success ? 'ok' : classify(result.code)
  }
  try {
    await getAcpTransport().respondPermission(agentId, ticket.requestId, optionId)
    return 'ok'
  } catch (error) {
    return classify(errorCode(error))
  }
}

/** Stop agent browsing for a session until the user's next message. */
export async function stopBrowserAgent(sessionId: string): Promise<boolean> {
  if (isTauriContext()) {
    const result = await invokeIpc<null>('browser_stop', { sessionId })
    return result.success
  }
  try {
    await getAcpTransport().stopBrowserAgent(sessionId)
    return true
  } catch {
    return false
  }
}
