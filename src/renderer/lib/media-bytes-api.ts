/**
 * Read an image, video, or PDF by path as a `Blob`. Desktop invokes the
 * `read_media_bytes` command; web/remote fetches `GET /fs/raw` with the bearer
 * header. Both are backed by the same host service, so the readable extensions,
 * the per-kind size caps, and the failure codes (`UNSUPPORTED_MEDIA`,
 * `FILE_TOO_LARGE`, `NOT_FOUND`, `NOT_A_FILE`, `READ_ERROR`, plus
 * `INVALID_PATH` on desktop, `PATH_TRAVERSAL` on web, and `NETWORK_ERROR` for a
 * failed or timed-out fetch) match on every surface.
 */

import type { IpcResult } from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import { networkError, parseBody, serverBase } from './ipc/http'
import { logFrontendError } from './log-api'
import { mediaMimeForPath } from './media-kind'
import { basename } from './path-basename'
import { isTauriContext } from './tauri-runtime'
import { authHeader } from './web-auth-token'
import { boundedFsRequest } from './web-server-api'

type MediaFailure = Extract<IpcResult<never>, { success: false }>

export async function readMediaBytes(path: string): Promise<IpcResult<Blob>> {
  const result = isTauriContext() ? await readDesktop(path) : await readWeb(path)
  if (!result.success) {
    void logFrontendError({
      level: 'warn',
      source: 'mediaBytes.read',
      message: `Failed to read media '${basename(path)}' (${result.code})`
    })
  }
  return result
}

async function readDesktop(path: string): Promise<IpcResult<Blob>> {
  try {
    const buffer = await invoke<ArrayBuffer>('read_media_bytes', { path })
    return {
      success: true,
      data: new Blob([buffer], { type: mediaMimeForPath(path) ?? 'application/octet-stream' })
    }
  } catch (error) {
    return desktopFailure(error)
  }
}

/** The command rejects with `{ code, message }`; anything else is an IPC fault. */
function desktopFailure(error: unknown): MediaFailure {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return { success: false, error: error.message, code: error.code }
  }
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    code: 'INVOKE_ERROR'
  }
}

function readWeb(path: string): Promise<IpcResult<Blob>> {
  return boundedFsRequest('readMediaBytes', async (signal) => {
    try {
      const res = await fetch(`${serverBase()}/fs/raw?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers: authHeader(),
        signal
      })
      if (!res.ok) return await parseBody<Blob>(res)
      return { success: true, data: await res.blob() }
    } catch (err) {
      return networkError(err instanceof Error ? err.message : String(err))
    }
  })
}
