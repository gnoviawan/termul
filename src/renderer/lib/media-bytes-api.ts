import { invoke } from '@tauri-apps/api/core'
import { serverBase } from './ipc/http'
import { logFrontendError } from './log-api'
import { mediaMimeForPath } from './media-kind'
import { basename } from './path-basename'
import { isTauriContext } from './tauri-runtime'
import { authHeader } from './web-auth-token'
import { boundedFsRequest } from './web-server-api'

const MEDIA_READ_CODES = [
  'UNSUPPORTED_MEDIA',
  'FILE_TOO_LARGE',
  'NOT_FOUND',
  'NOT_A_FILE',
  'READ_ERROR',
  'INVALID_PATH',
  'PATH_TRAVERSAL',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NETWORK_ERROR',
  'INVOKE_ERROR'
] as const

export type MediaReadCode = (typeof MEDIA_READ_CODES)[number]

/** `size` and `limit` (bytes) are set together, only on `FILE_TOO_LARGE`. */
export type MediaReadFailure = {
  success: false
  error: string
  code: MediaReadCode
  size?: number
  limit?: number
}

export type MediaReadResult = { success: true; data: Blob } | MediaReadFailure

export async function readMediaBytes(path: string): Promise<MediaReadResult> {
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

function isMediaReadCode(code: string): code is MediaReadCode {
  return (MEDIA_READ_CODES as readonly string[]).includes(code)
}

/** Parses a host failure; a code this client does not know becomes READ_ERROR. */
function hostFailure(error: string, code: string, detail: object): MediaReadFailure {
  const known = isMediaReadCode(code) ? code : 'READ_ERROR'
  const size = 'size' in detail ? detail.size : undefined
  const limit = 'limit' in detail ? detail.limit : undefined
  return typeof size === 'number' && typeof limit === 'number'
    ? { success: false, error, code: known, size, limit }
    : { success: false, error, code: known }
}

function failure(code: MediaReadCode, error: string): MediaReadFailure {
  return { success: false, error, code }
}

async function readDesktop(path: string): Promise<MediaReadResult> {
  try {
    const buffer = await invoke<ArrayBuffer>('read_media_bytes', { path })
    return {
      success: true,
      data: new Blob([buffer], { type: mediaMimeForPath(path) ?? 'application/octet-stream' })
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return hostFailure(error.message, error.code, error)
    }
    return failure('INVOKE_ERROR', error instanceof Error ? error.message : String(error))
  }
}

function readWeb(path: string): Promise<MediaReadResult> {
  return boundedFsRequest('readMediaBytes', async (signal) => {
    try {
      const res = await fetch(`${serverBase()}/fs/raw?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers: authHeader(),
        signal
      })
      if (res.ok) return { success: true, data: await res.blob() }
      const body: unknown = await res.json().catch(() => null)
      if (
        typeof body === 'object' &&
        body !== null &&
        'success' in body &&
        body.success === false &&
        'error' in body &&
        typeof body.error === 'string' &&
        'code' in body &&
        typeof body.code === 'string'
      ) {
        return hostFailure(body.error, body.code, body)
      }
      return failure('NETWORK_ERROR', `HTTP ${res.status} ${res.statusText}`)
    } catch (err) {
      return failure('NETWORK_ERROR', err instanceof Error ? err.message : String(err))
    }
  })
}
