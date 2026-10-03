/**
 * Fetch-based HTTP impl of the canvas facade (OpenPencil canvas mode, CAP-5).
 *
 * Mirrors the desktop Tauri commands over the three HTTP routes registered in
 * `src-tauri/src/web/canvas_api.rs` (same-origin under `termul-server`, all
 * three behind the outer bearer `web_auth_gate` — `postJson` merges the web
 * auth token's `Authorization` header):
 * - `POST /canvas/open` body `{ docPath, projectId }` — returns the
 *   same-origin embed path `/canvas/<id>/?embed=vscode&ct=<token>` plus the
 *   `canvasToken` the renderer sets as the per-canvas `op_canvas_ct_<id>`
 *   cookie;
 * - `POST /canvas/close` body `{ docPath }` — idempotent evict;
 * - `POST /canvas/save` body `{ docPath }` — daemon `POST /api/file/save`.
 *
 * Transport/parse failures map to `IpcResult { success: false, code:
 * 'NETWORK_ERROR' }`; a structured `IpcBody` failure (e.g. the gate's 401
 * UNAUTHORIZED, a typed DAEMON_DOWN) keeps the server-provided code/message.
 *
 * `status` has no web route by design (the pool snapshot is a desktop-side
 * diagnostic): the web adapter answers a typed `WEB_UNSUPPORTED` failure.
 */

import type {
  CanvasApi,
  CanvasOpenInfo,
  CanvasSaveResult,
  CanvasStatus
} from '@shared/types/canvas.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { postJson } from './ipc/http'

/** Per-canvas cookie prefix carrying the canvas session token for the
 * editor iframe's root-relative `/pkg|/canvaskit|/api` traffic and the
 * `/canvas/mcp` cookie path. The full name is `op_canvas_ct_<canvasId>` so
 * one web canvas cannot overwrite another's credential; mirrors
 * `web::canvas_api`'s per-canvas cookie name. Never logged. */
export const CANVAS_COOKIE_NAME = 'op_canvas_ct'

/** Resolve the canvas id from a web embed URL's `/canvas/<id>/…` path (the
 * open response also carries it as `canvasId`; the embed path is the
 * authoritative derivation). Null for non-canvas embed URLs. */
export function canvasIdOfEmbedUrl(embedUrl: string): string | null {
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.href : undefined
    const url = new URL(embedUrl, base)
    const match = url.pathname.match(/^\/canvas\/([^/]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** The per-canvas cookie name (`op_canvas_ct_<id>`); falls back to the bare
 * prefix when no id is resolvable. */
export function canvasCookieName(canvasId: string | null): string {
  return canvasId ? `${CANVAS_COOKIE_NAME}_${canvasId}` : CANVAS_COOKIE_NAME
}

/**
 * Set the canvas session token as the same-origin per-canvas cookie, BEFORE
 * the iframe mounts: the embedded editor's root-level requests (the editor
 * wasm derives its daemon base from `window.location.origin` and uses
 * absolute paths) authenticate through it. Refreshed on every open (web
 * tokens rotate). `Secure` is appended on https origins. Value never logged.
 */
function setCanvasCookie(canvasId: string | null, token: string): void {
  if (typeof document === 'undefined') return
  const secure =
    typeof window !== 'undefined' && window.location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${canvasCookieName(canvasId)}=${token}; Path=/; SameSite=Lax${secure}`
}

function webUnsupported(method: string): IpcResult<never> {
  return {
    success: false,
    error: `${method} is not available on the web transport`,
    code: 'WEB_UNSUPPORTED'
  }
}

/** The fetch-backed impl of [`CanvasApi`]; `canvas-api.ts` picks it when
 * `!isTauriContext()`. */
export const webCanvasApi: CanvasApi = {
  open(docPath: string, projectId: string): Promise<IpcResult<CanvasOpenInfo>> {
    const request = async (): Promise<IpcResult<CanvasOpenInfo>> => {
      const result = await postJson<CanvasOpenInfo>('/canvas/open', { docPath, projectId })
      if (result.success && result.data.canvasToken) {
        const canvasId = result.data.canvasId ?? canvasIdOfEmbedUrl(result.data.embedUrl)
        setCanvasCookie(canvasId, result.data.canvasToken)
      }
      return result
    }
    return request()
  },

  close(docPath: string): Promise<IpcResult<boolean>> {
    return postJson<boolean>('/canvas/close', { docPath })
  },

  save(docPath: string): Promise<IpcResult<CanvasSaveResult>> {
    return postJson<CanvasSaveResult>('/canvas/save', { docPath })
  },

  status(): Promise<IpcResult<CanvasStatus>> {
    return Promise.resolve(webUnsupported('status'))
  }
}
