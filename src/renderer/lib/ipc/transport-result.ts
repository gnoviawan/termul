/**
 * Map an ACP transport call to the `IpcResult<T>` envelope the facades return.
 *
 * The desktop catalog/install facades reach the host through the `/ws`
 * transport, whose failures arrive as {@link AcpTransportError} carrying the
 * host's SCREAMING_SNAKE_CASE code. Those become the same `{ success: false,
 * error, code }` body the HTTP routes return, so a consumer cannot tell the
 * carriers apart. Any other failure (a socket that never opened, a thrown
 * non-protocol error) maps to `INVOKE_ERROR`.
 */

import type { IpcResult } from '@shared/types/ipc.types'

import { AcpTransportError } from '../acp-transport/types'

export async function ipcResultFromTransport<T>(call: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await call() }
  } catch (error) {
    if (error instanceof AcpTransportError) {
      return { success: false, error: error.message, code: error.code }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}
