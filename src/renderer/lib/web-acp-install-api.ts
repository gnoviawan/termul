/**
 * Fetch-based HTTP impl of the ACP install facade (CAP-6 / Story 9).
 *
 * Mirrors the desktop Tauri command impl over the HTTP route registered in
 * `src-tauri/src/web/install_api.rs`. Transport/parse failures map to
 * `IpcResult { success: false, code: 'NETWORK_ERROR' }` so the renderer never
 * sees a thrown exception from the network layer.
 *
 * Route (same-origin under `termul-server`):
 * - `POST /acp/install` — install (body `{ agentId }`).
 *
 * The `IpcBody<T>` shape the HTTP route returns matches the renderer-side
 * `IpcResult<T>` byte-for-byte — this adapter only maps a transport/parse
 * failure to `NETWORK_ERROR`; a structured `IpcBody` is parsed into the
 * success/failure body variant the route returned on ANY status (the web auth
 * gate's 401 UNAUTHORIZED keeps its code/message).
 */

import type { AcpInstallApi, InstallOutcome } from '@shared/types/acp-install.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { postJson } from './ipc/http'

/**
 * The fetch-backed impl of [`AcpInstallApi`]. The singleton in
 * `acp-install-api.ts` picks this when `!isTauriContext()`.
 */
export const webAcpInstallApi: AcpInstallApi = {
  installAgent(agentId: string): Promise<IpcResult<InstallOutcome>> {
    return postJson<InstallOutcome>('/acp/install', { agentId })
  }
}
