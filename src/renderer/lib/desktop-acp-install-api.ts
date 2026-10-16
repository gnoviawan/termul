/**
 * Desktop implementation of the ACP install facade (CAP-6 / Story 9).
 *
 * The desktop sends `install_acp_agent` over the `/ws` contract (the Tauri IPC
 * channel carrier), the same request the web transport sends. The host answers
 * with the SAME payload and error codes as `POST /acp/install`
 * (`web-acp-install-api.ts`), so both implementations return the same
 * `IpcResult<...>` shape byte-for-byte — the `parity-checklist.test.ts` pins
 * this. The request carries `{ agentId }` only; the host resolves everything
 * from the trusted catalog.
 */

import type { AcpInstallApi, InstallOutcome } from '@shared/types/acp-install.types'
import type { IpcResult } from '@shared/types/ipc.types'

import { getAcpTransport } from './acp-transport'
import { ipcResultFromTransport } from './ipc/transport-result'

/**
 * Build the desktop impl of [`AcpInstallApi`]. The singleton in
 * `acp-install-api.ts` picks this when `isTauriContext()` is true.
 */
export function createDesktopAcpInstallApi(): AcpInstallApi {
  return {
    installAgent(agentId: string): Promise<IpcResult<InstallOutcome>> {
      return ipcResultFromTransport(() => getAcpTransport().installAcpAgent(agentId))
    }
  }
}
