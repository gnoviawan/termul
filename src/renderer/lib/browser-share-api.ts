/**
 * Renderer adapter for "Share to chat": a read-only, user-granted view of one
 * user browser tab for one chat session.
 *
 * The host owns the grant. The renderer only asks for one after an explicit
 * click in the main webview, shows what the host reports, and asks the host to
 * revoke it. The renderer never mints share ids or read capabilities, never
 * sees page content, and never reads a share itself. `shareId` is a host
 * handle for revoke and display; it is not the capability the agent reads
 * with, and it is never logged.
 *
 * Host contract (desktop `main` webview only; any other caller is refused):
 * - `browser_share_create({ tabId, sessionId, scopes, expectedOrigin })`
 *   → `IpcResult<BrowserShareView>`. Refused with `ORIGIN_CHANGED` when the
 *   tab's committed origin is not `expectedOrigin`, and `TAB_NOT_FOUND` when
 *   the tab is not a live user tab.
 * - `browser_share_revoke({ shareId })` → `IpcResult<void>`. An unknown or
 *   already ended share answers `NOT_FOUND`; the renderer treats that as gone.
 * - `browser_share_list()` → `IpcResult<BrowserShareView[]>`, so a reloaded
 *   renderer still shows every live share.
 * - event `browser_share_changed` with a `BrowserShareView` on every status
 *   change (expiry, navigation, tab close, revoke).
 *
 * Desktop only: user browser tabs are native Tauri webviews, so the web and
 * remote clients get `UNSUPPORTED` and render no share affordance.
 */

import { listen } from '@tauri-apps/api/event'
import type { ContentBlock } from './acp-api'
import { invokeIpc } from './ipc/tauri'
import { isTauriContext } from './tauri-runtime'

export type BrowserShareScope = 'content' | 'screenshot' | 'console_errors' | 'network_failures'

/**
 * The scopes the host grants today. User tabs carry no console or network
 * observer, so the host refuses `console_errors` and `network_failures`
 * with `SCOPE_UNAVAILABLE` instead of dropping them.
 */
export const BROWSER_SHARE_SCOPES: readonly BrowserShareScope[] = ['content', 'screenshot']

/** Least data by default: page content only; screenshot is opt-in. */
export const DEFAULT_BROWSER_SHARE_SCOPES: readonly BrowserShareScope[] = ['content']

/** `navigated`: the page left the granted document, so the user must share again. */
export type BrowserShareStatus = 'active' | 'expired' | 'revoked' | 'navigated' | 'closed'

export interface BrowserShareView {
  shareId: string
  sessionId: string
  tabId: string
  /** Host-canonical origin of the granted document. */
  origin: string
  scopes: BrowserShareScope[]
  expiresAtMs: number
  status: BrowserShareStatus
  /** Host-authored prompt reference. Never built from page text. */
  reference: { uri: string; name: string }
}

export type BrowserShareErrorCode =
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'ORIGIN_CHANGED'
  | 'TAB_NOT_FOUND'
  | 'NOT_FOUND'
  | 'INVALID_RESPONSE'
  | 'FAILED'

export type BrowserShareResult<T> =
  | { success: true; data: T }
  | { success: false; code: BrowserShareErrorCode }

const KNOWN_CODES = new Set<string>(['ORIGIN_CHANGED', 'TAB_NOT_FOUND', 'NOT_FOUND'])
const STATUSES = new Set<string>(['active', 'expired', 'revoked', 'navigated', 'closed'])
const SCOPES = new Set<string>(BROWSER_SHARE_SCOPES)

function unsupported<T>(): BrowserShareResult<T> {
  return { success: false, code: 'UNSUPPORTED' }
}

/** Map a host failure to a code. The host message is not kept: it can name the page. */
function failureCode(code: string, error: string): BrowserShareErrorCode {
  if (KNOWN_CODES.has(code)) return code as BrowserShareErrorCode
  if (code === 'INVOKE_ERROR' && /not found|unknown command/i.test(error)) return 'UNAVAILABLE'
  return 'FAILED'
}

/** Invoke a share command; any reply that is not an `IpcResult` is `INVALID_RESPONSE`. */
async function callHost(
  command: string,
  args?: Record<string, unknown>
): Promise<BrowserShareResult<unknown>> {
  const result: unknown = await invokeIpc<unknown>(command, args)
  if (typeof result !== 'object' || result === null || !('success' in result)) {
    return { success: false, code: 'INVALID_RESPONSE' }
  }
  const r = result as { success: unknown; data?: unknown; code?: unknown; error?: unknown }
  if (r.success === true) return { success: true, data: r.data }
  return {
    success: false,
    code: failureCode(
      typeof r.code === 'string' ? r.code : '',
      typeof r.error === 'string' ? r.error : ''
    )
  }
}

export function isBrowserShareView(value: unknown): value is BrowserShareView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const ref = v.reference as Record<string, unknown> | null | undefined
  return (
    typeof v.shareId === 'string' &&
    v.shareId.length > 0 &&
    typeof v.sessionId === 'string' &&
    typeof v.tabId === 'string' &&
    typeof v.origin === 'string' &&
    Array.isArray(v.scopes) &&
    v.scopes.length > 0 &&
    v.scopes.every((s) => typeof s === 'string' && SCOPES.has(s)) &&
    typeof v.expiresAtMs === 'number' &&
    Number.isFinite(v.expiresAtMs) &&
    typeof v.status === 'string' &&
    STATUSES.has(v.status) &&
    typeof ref === 'object' &&
    ref !== null &&
    typeof ref.uri === 'string' &&
    ref.uri.length > 0 &&
    typeof ref.name === 'string'
  )
}

export async function browserShareCreate(request: {
  tabId: string
  sessionId: string
  scopes: BrowserShareScope[]
  expectedOrigin: string
}): Promise<BrowserShareResult<BrowserShareView>> {
  if (!isTauriContext()) return unsupported()
  const result = await callHost('browser_share_create', request)
  if (!result.success) return result
  if (!isBrowserShareView(result.data)) return { success: false, code: 'INVALID_RESPONSE' }
  return { success: true, data: result.data }
}

export async function browserShareRevoke(shareId: string): Promise<BrowserShareResult<void>> {
  if (!isTauriContext()) return unsupported()
  const result = await callHost('browser_share_revoke', { shareId })
  if (!result.success) return result
  return { success: true, data: undefined }
}

export async function browserShareList(): Promise<BrowserShareResult<BrowserShareView[]>> {
  if (!isTauriContext()) return unsupported()
  const result = await callHost('browser_share_list')
  if (!result.success) return result
  if (!Array.isArray(result.data)) return { success: false, code: 'INVALID_RESPONSE' }
  return { success: true, data: result.data.filter(isBrowserShareView) }
}

/** Subscribe to host share status changes. Malformed payloads are dropped. */
export function onBrowserShareChanged(callback: (view: BrowserShareView) => void): () => void {
  if (!isTauriContext()) return () => {}
  const unlistenPromise = listen<unknown>('browser_share_changed', (event) => {
    if (isBrowserShareView(event.payload)) callback(event.payload)
  })
  return () => {
    void unlistenPromise.then((unlisten) => unlisten())
  }
}

/** The prompt block for a share: the host's reference, forwarded as is. */
export function browserShareBlock(view: BrowserShareView): ContentBlock {
  return { type: 'resource_link', uri: view.reference.uri, name: view.reference.name }
}

/** The origin a share request expects, from the tab's committed URL. */
export function browserShareOriginOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return parsed.origin
  } catch {
    return null
  }
}
