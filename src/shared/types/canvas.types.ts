/**
 * Canvas mode (figcraft embed) — shared runtime-neutral contracts.
 *
 * `CanvasOpenInfo` mirrors the camelCase serde shape of the Rust
 * `canvas::static_server::CanvasOpenInfo`, returned by both the desktop
 * `canvas_open` command and the web `POST /canvas/open` route. The renderer
 * builds the iframe URL from it; the Rust side never hands out a full URL so
 * the host origin stays renderer-owned. The persistence shapes mirror
 * `canvas::persistence` (spine AD-23): engine content versions are u64 and
 * always travel as decimal text, never as a JS number.
 */

import type { IpcResult } from './ipc.types'

export interface CanvasOpenInfo {
  /** Project-derived id the `/canvas/<id>/` bundle routes on. */
  canvasId: string
  /** Loopback origin on desktop (`http://127.0.0.1:<port>`); `''` on the web
   * client, where the bundle is same-origin. */
  baseUrl: string
  /** The `ct` session token for the bundle routes. Never logged. */
  canvasToken: string
  /** The figcraft tag this build pins; `host.describe` must report it. */
  pinTag: string
  /** Canonicalized absolute doc path. */
  docKey: string
  /** Host-allocated, never reused: stamps every bridge envelope and
   * persistence call of this mount. */
  mountSeq: number
}

/** The host's persistence projection of one mount. */
export interface CanvasPersistenceView {
  mountSeq: number
  /** The document is loaded; dirty state and saves are possible. */
  ready: boolean
  dirty: boolean
  contentVersion: string | null
  /** `null` until the document exists on disk. */
  savedVersion: string | null
  saveError: string | null
}

/** The mounted document as base64, `null` when the file does not exist yet. */
export interface CanvasDocumentBytes {
  bytes: string | null
}

/** How a forwarded `event.dirtyChanged` settled after the autosave debounce. */
export type CanvasDirtyOutcome =
  | { kind: 'superseded' }
  | { kind: 'idle'; view: CanvasPersistenceView }
  | { kind: 'saveDue'; view: CanvasPersistenceView }

export interface CanvasWriteOutcome {
  view: CanvasPersistenceView
  /** The version to send in `host.markSaved`; `null` when nothing was saved. */
  markSaved: string | null
}

/** How a host unmount (AD-31: quiesce, save, verify, unmount) ended. */
export interface CanvasCloseOutcome {
  /** False when the project had no mount. */
  unmounted: boolean
  /** The version on disk when the mount closed; `null` for a document never
   * written or a discard. */
  savedVersion: string | null
  /** Unsaved changes were dropped on the user's say-so. */
  discarded: boolean
}

/** Typed canvas facade and mount failure codes. */
export const CanvasErrorCodes = {
  PATH_VALIDATION_FAILED: 'PATH_VALIDATION_FAILED',
  TOKEN_GENERATION_FAILED: 'TOKEN_GENERATION_FAILED',
  BUNDLE_LISTENER_DOWN: 'BUNDLE_LISTENER_DOWN',
  BUNDLE_PIN_MISMATCH: 'BUNDLE_PIN_MISMATCH',
  EDITOR_CRASHED: 'EDITOR_CRASHED',
  DOCUMENT_LOAD_FAILED: 'DOCUMENT_LOAD_FAILED',
  CANVAS_CLOSED: 'CANVAS_CLOSED',
  CANVAS_CLOSING: 'CANVAS_CLOSING',
  SAVE_FAILED: 'SAVE_FAILED',
  CANVAS_NOT_READY: 'CANVAS_NOT_READY',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  READ_FAILED: 'READ_FAILED',
  UNSUPPORTED_SURFACE: 'UNSUPPORTED_SURFACE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVOKE_ERROR: 'INVOKE_ERROR'
} as const

export type CanvasErrorCode = (typeof CanvasErrorCodes)[keyof typeof CanvasErrorCodes]

/**
 * Typed errors of the editor control protocol (spine AD-25, integration
 * contracts "Typed errors"). Where figcraft's `Backend` only carries a
 * string, the string is the JSON encoding of `{code, message}`.
 */
export const CANVAS_BRIDGE_ERROR_CODES = [
  'CANVAS_CLOSED',
  'CANVAS_CLOSING',
  'CANVAS_HIDDEN',
  'CANVAS_OPEN_ELSEWHERE',
  'CANVAS_TIMEOUT',
  'UNSUPPORTED_IN_KIOSK',
  'UNKNOWN_METHOD',
  'ENGINE_ERROR'
] as const

export type CanvasBridgeErrorCode = (typeof CANVAS_BRIDGE_ERROR_CODES)[number]

/**
 * Transport-neutral canvas facade: desktop resolves to the `canvas_*` Tauri
 * commands, web to the `POST /canvas/*` routes of the same names. `open` is
 * gated off on phone-width viewports with a typed `UNSUPPORTED_SURFACE`.
 * The persistence methods are the renderer's half of AD-23: it forwards what
 * the editor reports and does what the host decides.
 */
export interface CanvasApi {
  open: (
    docPath: string,
    projectId: string,
    autosaveMs?: number
  ) => Promise<IpcResult<CanvasOpenInfo>>
  /** Unmount through the host's AD-31 sequence. A failed save answers
   * `SAVE_FAILED` and keeps the mount; `discard` is the user's explicit
   * choice to drop unsaved changes. */
  close: (projectId: string, discard?: boolean) => Promise<IpcResult<CanvasCloseOutcome>>
  readDocument: (projectId: string, mountSeq: number) => Promise<IpcResult<CanvasDocumentBytes>>
  /** `ack` is the `host.openDocument` result text, `null` for a new document. */
  documentLoaded: (
    projectId: string,
    mountSeq: number,
    ack: string | null
  ) => Promise<IpcResult<CanvasPersistenceView>>
  /** Resolves once the host's autosave debounce settles. */
  dirtyChanged: (
    projectId: string,
    mountSeq: number,
    dirty: boolean,
    contentVersion: string
  ) => Promise<IpcResult<CanvasDirtyOutcome>>
  /** `snapshot` is the `host.snapshot` result text, forwarded unparsed. */
  writeSnapshot: (
    projectId: string,
    mountSeq: number,
    snapshot: string
  ) => Promise<IpcResult<CanvasWriteOutcome>>
}
