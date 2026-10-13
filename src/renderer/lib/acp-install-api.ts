/**
 * ACP install API singleton (CAP-6 / Story 9).
 *
 * Resolves to the desktop impl (the `install_acp_agent` request over the Tauri
 * IPC channel carrier) when running inside a Tauri webview; the fetch-backed
 * HTTP impl when running as a web/remote client. Both impls
 * return the same `IpcResult<...>` shape byte-for-byte (the
 * `parity-checklist.test.ts` pins this).
 *
 * The host is the single source of truth for the install: it resolves the
 * agent by id from the catalog, downloads the HTTPS archive, verifies sha256
 * (from the catalog's `binary.{os-arch}.sha256` field), extracts safely,
 * atomically activates, serializes per-agent, records the manifest, and
 * returns `{ command, args }`. The browser request carries only `{ agentId }`.
 */

import type { AcpInstallApi } from '@shared/types/acp-install.types'
import { createDesktopAcpInstallApi } from './desktop-acp-install-api'
import { isTauriContext } from './tauri-runtime'
import { webAcpInstallApi } from './web-acp-install-api'

/**
 * Singleton `AcpInstallApi` instance.
 *
 * Uses the desktop implementation when running in a Tauri webview.
 * Uses the fetch-backed HTTP implementation when running in a browser.
 */
export const acpInstallApi: AcpInstallApi = isTauriContext()
  ? createDesktopAcpInstallApi()
  : webAcpInstallApi

export { createDesktopAcpInstallApi } from './desktop-acp-install-api'
export { webAcpInstallApi } from './web-acp-install-api'
