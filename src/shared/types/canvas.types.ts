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

/** A canvas the host unloaded (after saving it) to stay under
 * `canvas.max_mounted` (spine AD-26). */
export interface CanvasEviction {
  projectId: string
  reason: string
}

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
  /** Canvases this open unloaded to make room; the renderer marks them. */
  evicted: CanvasEviction[]
  /** System font URLs, relative to the bundle page, the renderer hands
   * `host.fallbackFonts` for characters the editor's own font lacks. Only
   * the desktop lists any; `[]` on the web client. */
  fallbackFonts: string[]
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
  /** The file changed on disk while the editor held unsaved work (AD-27);
   * autosave is suppressed until the user resolves it. */
  conflict: CanvasConflict | null
}

/** `diskHash` is the sha256 of the file on disk, `null` when it was deleted;
 * `version` is the editor's content version when the change was found. */
export interface CanvasConflict {
  diskHash: string | null
  version: string | null
}

/** What Termul's file watcher seeing the document change meant. */
export type CanvasDiskOutcome =
  | { kind: 'unchanged'; view: CanvasPersistenceView }
  | { kind: 'reload'; view: CanvasPersistenceView; bytes: string }
  | { kind: 'conflict'; view: CanvasPersistenceView }

/** The user's answer to a conflict: overwrite the disk with the editor,
 * reload the disk, or write the editor to a `.conflict-<time>` copy and
 * reload the disk. */
export type CanvasConflictChoice = 'keepMine' | 'takeDisk' | 'saveCopy'

export interface CanvasResolveOutcome {
  view: CanvasPersistenceView
  /** The disk's bytes to load with `host.openDocument`. */
  reload: string | null
  /** The conflict copy written by `saveCopy`. */
  copyPath: string | null
}

/** A crashed mount replaced by a fresh one loading the last saved bytes
 * (AD-31). */
export interface CanvasRemount {
  previousMountSeq: number
  mountSeq: number
  reason: string
  /** Edits the crash lost: `count` is `contentVersion - savedVersion`. */
  lost: { count: number; sinceMs: number | null } | null
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
  CANVAS_OPEN_ELSEWHERE: 'CANVAS_OPEN_ELSEWHERE',
  SAVE_FAILED: 'SAVE_FAILED',
  EVICTION_BLOCKED: 'EVICTION_BLOCKED',
  CANVAS_NOT_READY: 'CANVAS_NOT_READY',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  READ_FAILED: 'READ_FAILED',
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  COPY_FAILED: 'COPY_FAILED',
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
/** Why a window no longer holds a canvas mount: another window took the
 * lease (spine AD-30), the mount cap unloaded it (AD-26), or the host dropped
 * the mount after the window's connection was gone longer than the lease
 * grace. */
export type CanvasLeaseLoss = 'elsewhere' | 'evicted' | 'expired'

/** Settings sent with each open; the host clamps each. */
export interface CanvasOpenOptions {
  /** `canvas.autosave_ms`. */
  autosaveMs?: number
  /** `canvas.autosave_max_ms`: a dirty document is saved at least this
   * often while edits keep superseding the debounce. */
  autosaveMaxMs?: number
  /** `canvas.lease_grace_ms`: how long this window keeps the canvas after
   * its connection drops, so a reload or reconnect keeps it. */
  leaseGraceMs?: number
  /** `canvas.max_mounted`: opening beyond it unloads the least recently
   * active canvas first (`EVICTION_BLOCKED` when that canvas cannot be
   * saved). */
  maxMounted?: number
  /** `canvas.crash_timeouts`: consecutive timed-out calls that mark the
   * editor crashed and remount it. */
  crashTimeouts?: number
}

export interface CanvasApi {
  /** Mount the project's document in this window, which takes the mount
   * lease (spine AD-30). When another window holds it, that window saves and
   * unmounts first; if it cannot save, this answers `CANVAS_OPEN_ELSEWHERE`.
   * The transports send this window's `clientInstanceId` as the lease
   * holder. */
  open: (
    docPath: string,
    projectId: string,
    options?: CanvasOpenOptions
  ) => Promise<IpcResult<CanvasOpenInfo>>
  /** Unmount `mountSeq` through the host's AD-31 sequence. A mount that is no
   * longer the project's current one is left alone (`unmounted: false`), so
   * a late close cannot take down a newer mount. A failed save answers
   * `SAVE_FAILED` and keeps the mount; `discard` is the user's explicit
   * choice to drop unsaved changes. */
  close: (
    projectId: string,
    mountSeq: number,
    discard?: boolean
  ) => Promise<IpcResult<CanvasCloseOutcome>>
  /** The user started or stopped looking at the canvas: activity the host
   * ranks eviction by. `CANVAS_CLOSED` means the host no longer holds it. */
  setVisible: (projectId: string, mountSeq: number, visible: boolean) => Promise<IpcResult<void>>
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
  /** Termul's file watcher saw the document change (AD-27). `reloadFailed`:
   * the editor did not load the bytes a `reload` outcome handed it (it
   * refused them, or moved past the version the host judged clean), which
   * the host turns into a conflict. */
  diskChanged: (
    projectId: string,
    mountSeq: number,
    reloadFailed?: boolean
  ) => Promise<IpcResult<CanvasDiskOutcome>>
  /** `snapshot` is the `host.snapshot` result text, needed for `saveCopy`. */
  resolveConflict: (
    projectId: string,
    mountSeq: number,
    choice: CanvasConflictChoice,
    snapshot?: string
  ) => Promise<IpcResult<CanvasResolveOutcome>>
  /** The editor reported `event.crashed`: remount under a new `mountSeq`. */
  crashed: (
    projectId: string,
    mountSeq: number,
    reason: string
  ) => Promise<IpcResult<CanvasRemount>>
}
