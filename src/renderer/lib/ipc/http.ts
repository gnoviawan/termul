/**
 * Shared fetch helpers for the web/remote (`web-*-api.ts`) IPC adapters.
 *
 * In web/remote mode the browser is served by `termul-server` itself, so the
 * same-origin HTTP routes mirror the desktop Tauri commands. Every helper
 * maps transport/parse failures to `IpcResult { success: false, code:
 * 'NETWORK_ERROR' }` so the renderer never sees a thrown exception from the
 * network layer. A non-2xx response carrying a valid `IpcBody` failure (e.g.
 * the web auth gate's 401 UNAUTHORIZED) keeps the server-provided
 * code/message.
 */

import type { IpcResult } from '@shared/types/ipc.types'

import { isTauriContext } from '../tauri-runtime'
import { authHeader } from '../web-auth-token'

/**
 * Same-origin base for the embedded server. In web/remote mode the browser is
 * served by `termul-server` itself, so `window.location.origin` is the
 * server. Returns the empty string under Tauri (desktop build) so a
 * misconfigured call fails fast rather than hitting a phantom origin.
 */
export function serverBase(): string {
  if (isTauriContext()) return ''
  if (typeof window === 'undefined' || !window.location) return ''
  return window.location.origin
}

/** Shape of the HTTP response body mirroring `IpcResult<T>`. */
export type IpcBody<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }

/** Map any transport/parse failure to a uniform `IpcResult` failure. */
export function networkError(detail: string): IpcResult<never> {
  return { success: false, error: detail, code: 'NETWORK_ERROR' }
}

/**
 * Parse the `IpcBody<T>` JSON body into `IpcResult<T>`. A non-2xx response can
 * still carry a structured failure body — the web auth gate answers 401 with
 * `{ success: false, code: 'UNAUTHORIZED' }` — so the body is parsed FIRST and
 * a valid server-provided code/message is preserved on any status;
 * NETWORK_ERROR remains the fallback for absent/invalid bodies (and for any
 * transport throw).
 */
export async function parseBody<T>(res: Response): Promise<IpcResult<T>> {
  let body: IpcBody<T> | undefined
  try {
    body = (await res.json()) as IpcBody<T>
  } catch (err) {
    if (!res.ok) return networkError(`HTTP ${res.status} ${res.statusText}`)
    return networkError(err instanceof Error ? err.message : 'invalid JSON')
  }
  if (
    body !== null &&
    typeof body === 'object' &&
    body.success === false &&
    typeof body.error === 'string' &&
    typeof body.code === 'string'
  ) {
    return { success: false, error: body.error, code: body.code }
  }
  if (!res.ok) {
    return networkError(`HTTP ${res.status} ${res.statusText}`)
  }
  if (body !== null && typeof body === 'object' && body.success === true) {
    return { success: true, data: body.data }
  }
  return networkError('invalid response body')
}

/** GET and return the typed `IpcResult` body (or NETWORK_ERROR). */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'GET',
      headers: authHeader(),
      signal
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** POST JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
export async function postJson<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
      signal
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** PUT JSON and return the typed `IpcResult` body (or NETWORK_ERROR). */
export async function putJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(body)
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}
