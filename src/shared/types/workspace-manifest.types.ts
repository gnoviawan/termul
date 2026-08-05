/**
 * Host-owned versioned workspace manifest contract (CAP-5 / Story 5).
 *
 * Mirrors the Rust serde shapes in `src-tauri/src/acp/workspace_manifest.rs`
 * byte-for-byte (camelCase, `deny_unknown_fields` enforced at the host
 * boundary). The host owns one portable manifest per project; the renderer
 * reads/writes/conflict-renders through this contract (Story 6 wires the
 * actual renderer store integration).
 *
 * The manifest NEVER carries secrets, viewport geometry, native window state,
 * device-specific decorations, or the raw CAP-3 claim credential — the
 * manifest struct simply does not declare these fields; the host's
 * `deny_unknown_fields` rejects an over-serialized payload loudly with
 * `VALIDATION_ERROR`. The `TerminalDescriptor.claimHandle` is an opaque
 * caller-supplied string the renderer pairs back to its in-memory claim (the
 * host never dereferences, logs, or persists the raw claim).
 */

import type { IpcResult } from './ipc.types'

/** Direction for a split node. Mirrors `PaneDirection` in workspace.types.ts. */
export type PaneDirection = 'horizontal' | 'vertical'

/**
 * Portable split node. Mirrors `SplitNode` minus the workspace-only `tabs`
 * field. The `sizes` array is the proportional pane-size split the renderer
 * restores verbatim — it carries no viewport dimensions or window-state.
 */
export interface SplitNode {
  type: 'split'
  id: string
  direction: PaneDirection
  children: PaneNode[]
  sizes: number[]
}

/**
 * Portable leaf node. Mirrors `LeafNode` minus the workspace-only `tabs`
 * field (a restored workspace repopulates `tabs` from `terminalIds` +
 * `editorIds` + the active id).
 */
export interface LeafNode {
  type: 'leaf'
  id: string
  terminalIds: string[]
  editorIds: string[]
  activeTabId?: string | null
}

/** Portable pane tree node (split or leaf, tagged via `type`). */
export type PaneNode = SplitNode | LeafNode

/**
 * Portable terminal descriptor. Carries just enough of a `WorkspaceTab`
 * terminal entry for cross-client restore. The `claimHandle` is an opaque
 * caller-supplied string the renderer pairs back to its in-memory CAP-3 claim
 * — the host NEVER dereferences, logs, or persists the raw claim.
 */
export interface TerminalDescriptor {
  terminalId: string
  projectId: string
  shell: string
  cwd: string
  name: string
  worktreeId?: string
  claimHandle?: string
}

/** Portable editor descriptor. A restored editor tab reopens a file path. */
export interface EditorDescriptor {
  editorId: string
  filePath: string
}

/**
 * The portable workspace manifest. Owned by the host, one per project.
 *
 * `revision` is monotonic from 1, incremented on each successful write;
 * `updateIdentity` is caller-supplied opaque string (Epic 2 wires real auth);
 * `updatedAt` is epoch millis.
 */
export interface WorkspaceManifest {
  projectId: string
  revision: number
  updateIdentity?: string
  updatedAt: number
  topology?: PaneNode
  activePaneId?: string | null
  focusedSessionId?: string | null
  terminals: TerminalDescriptor[]
  editors: EditorDescriptor[]
}

/**
 * Result of a revision-checked write. Serialized via `tag=status` so the wire
 * shape is `{ status: 'updated'; revision; updatedAt }` |
 * `{ status: 'conflict'; currentRevision; currentUpdatedAt;
 * currentUpdateIdentity }`. Conflict is a SUCCESS body variant, NOT an
 * error code — the caller branches on the `status` discriminator.
 */
export type WriteOutcome =
  | { status: 'updated'; revision: number; updatedAt: number }
  | {
      status: 'conflict'
      currentRevision: number
      currentUpdatedAt: number
      currentUpdateIdentity?: string
    }

/**
 * `workspace_manifest_get(projectId)` — load a project's manifest. Returns
 * `IpcResult.success(null)` when no manifest exists (the success path — a
 * workspace reload starts fresh). Mirrors `GET /workspace/:projectId`.
 */
export type WorkspaceManifestGetChannel = (
  projectId: string
) => Promise<IpcResult<WorkspaceManifest | null>>

/**
 * `workspace_manifest_write(projectId, basedRevision, manifest)` —
 * revision-checked write. `basedRevision: null` = initial write (no prior
 * revision); the host compares against the on-disk `revision` and returns
 * `WriteOutcome.Conflict` on mismatch WITHOUT mutating state. Mirrors
 * `POST /workspace/:projectId/write`.
 */
export type WorkspaceManifestWriteChannel = (
  projectId: string,
  basedRevision: number | null,
  manifest: WorkspaceManifest
) => Promise<IpcResult<WriteOutcome>>

/**
 * `workspace_manifest_delete(projectId)` — idempotent delete. Returns
 * `IpcResult.success(void)` whether the file existed or not. Mirrors
 * `POST /workspace/:projectId/delete`.
 */
export type WorkspaceManifestDeleteChannel = (projectId: string) => Promise<IpcResult<void>>

/**
 * The renderer-facing workspace-manifest facade. Resolves to the Tauri
 * command impl when running inside a Tauri webview, the HTTP fetch impl
 * when running as a web/remote client. Both impls return the same
 * `IpcResult<...>` shape byte-for-byte (the parity-checklist test pins this).
 */
export interface WorkspaceManifestApi {
  getManifest: WorkspaceManifestGetChannel
  writeManifest: WorkspaceManifestWriteChannel
  deleteManifest: WorkspaceManifestDeleteChannel
}

/** Wire body for `POST /workspace/:projectId/write` (camelCase). */
export interface WorkspaceManifestWriteRequestBody {
  basedRevision: number | null
  manifest: WorkspaceManifest
}
