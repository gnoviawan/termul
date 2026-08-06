/**
 * ACP catalog API singleton (CAP-6 / Story 8).
 *
 * Resolves to the Tauri IPC impl when running inside a Tauri webview; the
 * fetch-backed HTTP impl when running as a web/remote client. Both impls
 * return the same `IpcResult<...>` shape byte-for-byte (the
 * `parity-checklist.test.ts` pins this).
 *
 * The host is the single source of truth for: OS, arch, runtime availability,
 * and per-agent installability status. Web clients consume the host's answer;
 * they never probe `@tauri-apps/plugin-os` or PATH locally.
 */

import type { AcpCatalogApi } from '@shared/types/acp-catalog.types'
import { createTauriAcpCatalogApi } from './tauri-acp-catalog-api'
import { isTauriContext } from './tauri-runtime'
import { webAcpCatalogApi } from './web-acp-catalog-api'

/**
 * Singleton `AcpCatalogApi` instance.
 *
 * Uses the Tauri IPC implementation when running in a Tauri webview.
 * Uses the fetch-backed HTTP implementation when running in a browser.
 */
export const acpCatalogApi: AcpCatalogApi = isTauriContext()
  ? createTauriAcpCatalogApi()
  : webAcpCatalogApi

export { createTauriAcpCatalogApi } from './tauri-acp-catalog-api'
export { webAcpCatalogApi } from './web-acp-catalog-api'
