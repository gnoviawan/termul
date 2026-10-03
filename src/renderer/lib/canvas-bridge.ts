/**
 * `postMessage` bridge between the Termul renderer host and the embedded
 * OpenPencil editor iframe (AD-4: the only host↔editor channel).
 *
 * Speaks the `op_editor_core::bridge_protocol` wire contract VERBATIM: every
 * message is a JSON **string** (never an object) whose top-level `type` is
 * one of the `op-bridge/*` / `op-shell/*` literals below; field names are
 * camelCase (`requestId`, `serverVersion`). The codec half is pure
 * (build/parse) and unit-testable; the adapter half owns the DOM wiring:
 *
 * - source + origin lock: inbound events must come from the iframe's own
 *   `contentWindow` AND carry the iframe's origin (the editor mirrors this
 *   with `event.source === window.parent` + its own origin lock on init). An
 *   UNPARSEABLE embed URL (origin `''`) locks the bridge entirely — no
 *   inbound message may pass and no outbound post is attempted (a `''`
 *   `targetOrigin` would throw);
 * - `init` retry: posted immediately, retried every 500ms (max 20) until
 *   `ready`; `op-bridge/listening` (the editor's early-listener
 *   announcement, posted before the wasm download finishes) resets the
 *   budget and re-posts `init` at once. When the retry budget is exhausted
 *   without `listening`/`ready`, the bridge reports `onInitFailed` once;
 * - `op-shell/save` → the host save flow; `op-shell/copy` → the host
 *   clipboard (the nested cross-origin iframe cannot write it itself);
 *   `op-shell/open-external` is explicitly ignored (logged once, info
 *   level — the URL is never logged).
 *
 * Foreign postMessage traffic (react-devtools, objects, malformed JSON) is
 * silently ignored, never an error — mirroring the editor's own codec.
 */

import { logFrontendError } from './log-api'

/** Verbatim `op-bridge/*` / `op-shell/*` wire strings (host → editor). */
export const BRIDGE_HOST_MESSAGES = {
  INIT: 'op-bridge/init',
  THEME: 'op-bridge/theme',
  LOCALE: 'op-bridge/locale',
  OPEN_DOCUMENT: 'op-bridge/open-document',
  SNAPSHOT: 'op-bridge/snapshot',
  SAVE_COMMITTED: 'op-bridge/save-committed',
  RESOLVE_CONFLICT: 'op-bridge/resolve-conflict'
} as const

/** Verbatim wire strings (editor → host). */
export const BRIDGE_EDITOR_MESSAGES = {
  READY: 'op-bridge/ready',
  LISTENING: 'op-bridge/listening',
  DIRTY_CHANGED: 'op-bridge/dirty-changed',
  OPENED: 'op-bridge/opened',
  SNAPSHOT_RESULT: 'op-bridge/snapshot-result',
  SNAPSHOT_CONFLICT: 'op-bridge/snapshot-conflict',
  SYNC_CONFLICT: 'op-bridge/sync-conflict',
  CONFLICT_RESOLVED: 'op-bridge/conflict-resolved'
} as const

/** Verbatim `op-shell/*` control strings (editor → shell). */
export const SHELL_CONTROL_MESSAGES = {
  READY: 'op-shell/ready',
  SAVE: 'op-shell/save',
  COPY: 'op-shell/copy',
  OPEN_EXTERNAL: 'op-shell/open-external'
} as const

/** Init retry cadence (mirrors the OpenPencil host contract: 500ms / 20). */
export const BRIDGE_INIT_RETRY_MS = 500
export const BRIDGE_INIT_MAX_TRIES = 20

/**
 * Desktop init token. Managed daemons are tokenless per request (the
 * handshake token is lifecycle-only and deliberately never leaves the Rust
 * host), but the editor's codec requires a non-empty `token` to select the
 * managed bootstrap — this constant fills that slot. Never a secret.
 */
export const DESKTOP_BRIDGE_INIT_TOKEN = 'termul-canvas'

/** The two color schemes the editor's codec accepts. */
export type BridgeColorScheme = 'light' | 'dark'

/** The two conflict modes the editor's codec accepts. */
export type BridgeConflictMode = 'use-local' | 'accept-remote'

// ---------------------------------------------------------------------------
// Codec — host → editor builders (pure)
// ---------------------------------------------------------------------------

export function buildInitMessage(token: string, mcpUrl?: string): string {
  return JSON.stringify({
    type: BRIDGE_HOST_MESSAGES.INIT,
    token,
    ...(mcpUrl ? { mcpUrl } : {})
  })
}

export function buildThemeMessage(colorScheme: BridgeColorScheme): string {
  return JSON.stringify({ type: BRIDGE_HOST_MESSAGES.THEME, colorScheme })
}

export function buildLocaleMessage(locale: string): string {
  return JSON.stringify({ type: BRIDGE_HOST_MESSAGES.LOCALE, locale })
}

export function buildOpenDocumentMessage(json: string): string {
  return JSON.stringify({ type: BRIDGE_HOST_MESSAGES.OPEN_DOCUMENT, json })
}

export function buildSnapshotMessage(purpose: string, requestId: string): string {
  return JSON.stringify({
    type: BRIDGE_HOST_MESSAGES.SNAPSHOT,
    purpose,
    requestId
  })
}

export function buildSaveCommittedMessage(generation: number, revision: number): string {
  return JSON.stringify({
    type: BRIDGE_HOST_MESSAGES.SAVE_COMMITTED,
    generation,
    revision
  })
}

export function buildResolveConflictMessage(mode: BridgeConflictMode, requestId: string): string {
  return JSON.stringify({
    type: BRIDGE_HOST_MESSAGES.RESOLVE_CONFLICT,
    mode,
    requestId
  })
}

// ---------------------------------------------------------------------------
// Codec — editor → host event parsing (pure)
// ---------------------------------------------------------------------------

export type CanvasBridgeEvent =
  | { type: 'listening' }
  | { type: 'ready'; generation: number; revision: number }
  | { type: 'opened'; generation: number }
  | {
      type: 'dirty-changed'
      generation: number
      revision: number
      dirty: boolean
    }
  | {
      type: 'snapshot-result'
      requestId: string
      docJson: string
      generation: number
      revision: number
    }
  | { type: 'snapshot-conflict'; requestId: string; serverVersion: number }
  | {
      type: 'sync-conflict'
      generation: number
      revision: number
      serverVersion: number
    }
  | { type: 'conflict-resolved'; requestId: string }

function parseJsonString(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Parse an editor → host bridge event from a raw postMessage payload.
 * Returns null for anything that is not a known `op-bridge/*` event
 * (foreign traffic, malformed JSON, shell control messages).
 */
export function parseBridgeEvent(raw: unknown): CanvasBridgeEvent | null {
  const value = parseJsonString(raw)
  if (value === null) return null
  switch (value.type) {
    case BRIDGE_EDITOR_MESSAGES.LISTENING:
      return { type: 'listening' }
    case BRIDGE_EDITOR_MESSAGES.READY: {
      const generation = asNumber(value.generation)
      const revision = asNumber(value.revision)
      if (generation === null || revision === null) return null
      return { type: 'ready', generation, revision }
    }
    case BRIDGE_EDITOR_MESSAGES.OPENED: {
      const generation = asNumber(value.generation)
      if (generation === null) return null
      return { type: 'opened', generation }
    }
    case BRIDGE_EDITOR_MESSAGES.DIRTY_CHANGED: {
      const generation = asNumber(value.generation)
      const revision = asNumber(value.revision)
      if (generation === null || revision === null || typeof value.dirty !== 'boolean') return null
      return { type: 'dirty-changed', generation, revision, dirty: value.dirty }
    }
    case BRIDGE_EDITOR_MESSAGES.SNAPSHOT_RESULT: {
      const generation = asNumber(value.generation)
      const revision = asNumber(value.revision)
      if (
        typeof value.requestId !== 'string' ||
        typeof value.docJson !== 'string' ||
        generation === null ||
        revision === null
      ) {
        return null
      }
      return {
        type: 'snapshot-result',
        requestId: value.requestId,
        docJson: value.docJson,
        generation,
        revision
      }
    }
    case BRIDGE_EDITOR_MESSAGES.SNAPSHOT_CONFLICT: {
      const serverVersion = asNumber(value.serverVersion)
      if (typeof value.requestId !== 'string' || serverVersion === null) return null
      return { type: 'snapshot-conflict', requestId: value.requestId, serverVersion }
    }
    case BRIDGE_EDITOR_MESSAGES.SYNC_CONFLICT: {
      const generation = asNumber(value.generation)
      const revision = asNumber(value.revision)
      const serverVersion = asNumber(value.serverVersion)
      if (generation === null || revision === null || serverVersion === null) return null
      return { type: 'sync-conflict', generation, revision, serverVersion }
    }
    case BRIDGE_EDITOR_MESSAGES.CONFLICT_RESOLVED: {
      if (typeof value.requestId !== 'string') return null
      return { type: 'conflict-resolved', requestId: value.requestId }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Shell control messages (editor → host) — matched on the parsed top-level
// `type`, never a substring of the raw payload (a legitimate business
// message whose docJson embeds the text "op-shell/" must never be swallowed).
// ---------------------------------------------------------------------------

/** True for an `op-shell/save` control message (the editor forwarded a
 * Cmd/Ctrl+S it saw inside the cross-origin iframe). */
export function isShellSaveRequest(raw: unknown): boolean {
  const value = parseJsonString(raw)
  return value !== null && value.type === SHELL_CONTROL_MESSAGES.SAVE
}

/** The text payload of an `op-shell/copy` control message, else undefined. */
export function parseShellCopyText(raw: unknown): string | undefined {
  const value = parseJsonString(raw)
  if (value === null || value.type !== SHELL_CONTROL_MESSAGES.COPY) return undefined
  return typeof value.text === 'string' ? value.text : undefined
}

/** True for an `op-shell/open-external` control message (auth/help pages the
 * embedded editor asks the host to open — Termul ignores them; the URL is
 * never logged). */
export function isShellOpenExternal(raw: unknown): boolean {
  const value = parseJsonString(raw)
  return value !== null && value.type === SHELL_CONTROL_MESSAGES.OPEN_EXTERNAL
}

// ---------------------------------------------------------------------------
// Adapter — postMessage wiring
// ---------------------------------------------------------------------------

/**
 * Derive the iframe origin from an embed URL. Desktop embed URLs are
 * absolute loopback URLs; web embed URLs are same-origin relative paths
 * (`/canvas/<id>/…`) whose origin is the page's own.
 */
export function originOfEmbedUrl(embedUrl: string): string {
  if (embedUrl.startsWith('/')) {
    return typeof window !== 'undefined' && window.location ? window.location.origin : ''
  }
  try {
    return new URL(embedUrl).origin
  } catch {
    return ''
  }
}

/**
 * Map the host locale to a value the editor's codec accepts (it strictly
 * accepts only `en-US` and `zh-CN`): any `zh*` locale maps to `zh-CN`,
 * everything else to `en-US`.
 */
export function toSupportedBridgeLocale(language: string): 'en-US' | 'zh-CN' {
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export interface CanvasBridgeController {
  sendTheme(colorScheme: BridgeColorScheme): void
  sendLocale(locale: string): void
  sendSaveCommitted(generation: number, revision: number): void
  sendResolveConflict(mode: BridgeConflictMode, requestId: string): void
  dispose(): void
}

export interface CanvasBridgeOptions {
  /** The embedded editor iframe (the bridge posts to its `contentWindow`). */
  iframe: HTMLIFrameElement
  /** The iframe's origin — used as the explicit `targetOrigin` (never `*`)
   * and enforced on every inbound message. */
  iframeOrigin: string
  /** Init token (web: the canvas session token; desktop: the constant). */
  token: string
  /** Stable Termul-proxied MCP endpoint surfaced in the editor's MCP card. */
  mcpUrl?: string
  onEvent: (event: CanvasBridgeEvent) => void
  /** `op-shell/save` — the host save flow. */
  onShellSave: () => void
  /** `op-shell/copy` — the host clipboard write. */
  onShellCopy: (text: string) => void
  /** Fired once when the init retry budget is exhausted without the editor
   * reaching `listening`/`ready` (the store surfaces a failure state). */
  onInitFailed?: () => void
}

/**
 * Create the bridge adapter for one embedded editor iframe. Owns the window
 * `message` listener and the `init` retry loop; `dispose()` tears both down
 * (the panel calls it when the iframe unmounts or re-navigates).
 */
export function createCanvasBridge(options: CanvasBridgeOptions): CanvasBridgeController {
  const { iframe, iframeOrigin, token, mcpUrl, onEvent, onShellSave, onShellCopy, onInitFailed } =
    options

  let disposed = false
  let ready = false
  let initTries = 0
  let initFailedReported = false
  let openExternalLogged = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  // An unparseable embed URL (origin '') locks the bridge entirely: no
  // inbound message may pass the origin check, and no outbound post is
  // attempted (an empty `targetOrigin` would throw). The bridge still
  // attaches so a later remount with a valid origin can replace it.
  if (iframeOrigin === '') {
    void logFrontendError({
      level: 'warn',
      source: 'canvas-bridge.origin',
      message:
        'canvas bridge created with an unparseable embed origin — the bridge is locked (no messages may pass)'
    })
  }

  const postToIframe = (json: string): void => {
    if (disposed || iframeOrigin === '') return
    iframe.contentWindow?.postMessage(json, iframeOrigin)
  }

  const postInit = (): void => {
    postToIframe(buildInitMessage(token, mcpUrl))
  }

  const stopRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const reportInitFailed = (): void => {
    if (initFailedReported) return
    initFailedReported = true
    void logFrontendError({
      level: 'warn',
      source: 'canvas-bridge.init',
      message: `canvas bridge init retry budget exhausted (${BRIDGE_INIT_MAX_TRIES} tries, ${BRIDGE_INIT_RETRY_MS}ms apart) without a listening/ready event`
    })
    onInitFailed?.()
  }

  const scheduleInitRetry = (): void => {
    stopRetry()
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (disposed || ready) return
      initTries += 1
      if (initTries >= BRIDGE_INIT_MAX_TRIES) {
        reportInitFailed()
        return
      }
      postInit()
      scheduleInitRetry()
    }, BRIDGE_INIT_RETRY_MS)
  }

  const restartInit = (): void => {
    if (disposed || ready) return
    initTries = 0
    postInit()
    scheduleInitRetry()
  }

  const handleMessage = (event: MessageEvent): void => {
    if (disposed) return
    // Origin + source lock: only the embedded editor iframe may drive the
    // bridge; anything else (other frames, foreign traffic) is dropped. An
    // empty (unparseable) origin NEVER matches — every message is foreign.
    if (iframeOrigin === '' || event.origin !== iframeOrigin) return
    if (event.source !== iframe.contentWindow) return
    const raw = event.data
    if (typeof raw !== 'string') return
    if (isShellSaveRequest(raw)) {
      onShellSave()
      return
    }
    const copyText = parseShellCopyText(raw)
    if (copyText !== undefined) {
      onShellCopy(copyText)
      return
    }
    // `op-shell/open-external` (auth/help pages): Termul does not open
    // external pages from the embedded editor — ignore, but not silently
    // (logged once per bridge; the requested URL is never logged).
    if (isShellOpenExternal(raw)) {
      if (!openExternalLogged) {
        openExternalLogged = true
        void logFrontendError({
          level: 'info',
          source: 'canvas-bridge.shell',
          message: 'editor open-external request ignored (not supported by the canvas host)'
        })
      }
      return
    }
    const bridgeEvent = parseBridgeEvent(raw)
    if (bridgeEvent === null) return
    if (bridgeEvent.type === 'listening') {
      // The editor's early listener is up: re-send init at once and renew
      // the bounded retry window (it may have expired during the wasm
      // download).
      restartInit()
    } else if (bridgeEvent.type === 'ready') {
      ready = true
      stopRetry()
    }
    onEvent(bridgeEvent)
  }

  window.addEventListener('message', handleMessage)
  postInit()
  scheduleInitRetry()

  return {
    sendTheme(colorScheme: BridgeColorScheme): void {
      postToIframe(buildThemeMessage(colorScheme))
    },
    sendLocale(locale: string): void {
      postToIframe(buildLocaleMessage(locale))
    },
    sendSaveCommitted(generation: number, revision: number): void {
      postToIframe(buildSaveCommittedMessage(generation, revision))
    },
    sendResolveConflict(mode: BridgeConflictMode, requestId: string): void {
      postToIframe(buildResolveConflictMessage(mode, requestId))
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      stopRetry()
      window.removeEventListener('message', handleMessage)
    }
  }
}
