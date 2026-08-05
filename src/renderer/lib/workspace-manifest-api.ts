/**
 * Workspace-manifest API singleton (CAP-5 / Story 5).
 *
 * Resolves to the Tauri IPC impl when running inside a Tauri webview; the
 * fetch-backed HTTP impl when running as a web/remote client. Both impls
 * return the same `IpcResult<...>` shape byte-for-byte (the
 * `parity-checklist.test.ts` pins this).
 *
 * Story 5 ships the contract + parity surfaces; it does NOT change renderer
 * workspace-store / snapshot-store / project-store / use-projects-persistence
 * wiring — that is Story 6 (Integrate cross-client workspace restore). The
 * facade is the only surface Story 5 ships; downstream callers land in
 * Story 6.
 */

import type { WorkspaceManifestApi } from '@shared/types/workspace-manifest.types'

import { isTauriContext } from './tauri-runtime'
import { createTauriWorkspaceManifestApi } from './tauri-workspace-manifest-api'
import { webWorkspaceManifestApi } from './web-workspace-manifest-api'

/**
 * Singleton `WorkspaceManifestApi` instance.
 *
 * Uses the Tauri IPC implementation when running in a Tauri webview.
 * Uses the fetch-backed HTTP implementation when running in a browser.
 */
export const workspaceManifestApi: WorkspaceManifestApi = isTauriContext()
  ? createTauriWorkspaceManifestApi()
  : webWorkspaceManifestApi

export { createTauriWorkspaceManifestApi } from './tauri-workspace-manifest-api'
export { webWorkspaceManifestApi } from './web-workspace-manifest-api'
