/**
 * OpenPencil canvas mode — shared runtime-neutral contracts.
 *
 * Mirrors the camelCase serde shapes of the Rust canvas subsystem
 * (`src-tauri/src/canvas/mod.rs` + `commands/canvas.rs` / `web/canvas_api.rs`):
 * - desktop `canvas_open` returns the loopback embed URL
 *   (`http://127.0.0.1:<port>/?embed=vscode`, raw-concat query — never
 *   URL-encoded) with `mcpUrl` from the agentation server, no canvas id/token;
 * - web `POST /canvas/open` returns the same-origin proxy path
 *   `/canvas/<canvasId>/?embed=vscode&ct=<token>` plus the same token as
 *   `canvasToken` (the renderer sets it as the `op_canvas_ct` cookie).
 *
 * The `IpcResult` envelope and typed SCREAMING_SNAKE codes match the Rust
 * `CanvasError` set exactly; `UNSUPPORTED_SURFACE` is the renderer-side gate
 * for phone-width viewports (no canvas on the mobile web shell).
 */

import type { IpcResult } from './ipc.types'

/** Result of opening a canvas (mirrors Rust `CanvasOpenInfo`, camelCase). */
export interface CanvasOpenInfo {
  /** Iframe `src`, used verbatim — desktop loopback URL or web proxy path. */
  embedUrl: string
  /** Stable Termul-proxied MCP endpoint; `null` when the desktop agentation
   * server is unavailable (the renderer then skips the MCP upsert). */
  mcpUrl?: string | null
  /** Canonicalized absolute doc path (the pool's daemon key). */
  docKey: string
  /** Web-only: project-derived id the `/canvas/<id>/*` proxy routes on. */
  canvasId?: string
  /** Web-only: canvas session token (the `ct` embed param / the
   * `op_canvas_ct` cookie value). Never logged. */
  canvasToken?: string
}

/** One live managed daemon (mirrors Rust `CanvasDaemonInfo`). */
export interface CanvasDaemonInfo {
  docKey: string
  port: number
  version: string
}

/** Pool snapshot (mirrors Rust `CanvasStatus`). */
export interface CanvasStatus {
  daemons: CanvasDaemonInfo[]
  activeDocKey: string | null
}

/** Daemon save response body (`POST /api/file/save`) — opaque JSON. */
export type CanvasSaveResult = Record<string, unknown>

/**
 * Typed canvas facade error codes. The Rust-side codes mirror
 * `src-tauri/src/canvas/mod.rs`; the transport/gate codes mirror the shared
 * IPC conventions (`NETWORK_ERROR`, `INVOKE_ERROR`, `UNSUPPORTED_SURFACE`,
 * `WEB_UNSUPPORTED`).
 */
export const CanvasErrorCodes = {
  BINARY_NOT_FOUND: 'BINARY_NOT_FOUND',
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  HANDSHAKE_INVALID: 'HANDSHAKE_INVALID',
  SPAWN_FAILED: 'SPAWN_FAILED',
  DAEMON_DOWN: 'DAEMON_DOWN',
  PATH_VALIDATION_FAILED: 'PATH_VALIDATION_FAILED',
  CANVAS_CLOSED: 'CANVAS_CLOSED',
  SAVE_FAILED: 'SAVE_FAILED',
  TOKEN_GENERATION_FAILED: 'TOKEN_GENERATION_FAILED',
  UNSUPPORTED_SURFACE: 'UNSUPPORTED_SURFACE',
  WEB_UNSUPPORTED: 'WEB_UNSUPPORTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVOKE_ERROR: 'INVOKE_ERROR'
} as const

export type CanvasErrorCode = (typeof CanvasErrorCodes)[keyof typeof CanvasErrorCodes]

/**
 * Transport-neutral canvas facade. Desktop resolves to the Tauri command
 * adapter (`canvas_open` / `canvas_close` / `canvas_save` / `canvas_status`);
 * web resolves to the same-origin HTTP routes (`POST /canvas/open|close|save`
 * behind the bearer web auth gate). `open`/`save` are gated off on
 * phone-width viewports with a typed `UNSUPPORTED_SURFACE` failure.
 */
export interface CanvasApi {
  open: (docPath: string, projectId: string) => Promise<IpcResult<CanvasOpenInfo>>
  close: (docPath: string) => Promise<IpcResult<boolean>>
  save: (docPath: string) => Promise<IpcResult<CanvasSaveResult>>
  status: () => Promise<IpcResult<CanvasStatus>>
}
