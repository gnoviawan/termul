/**
 * Workspace-manifest sync hook (CAP-5 / Story 6).
 *
 * Owns the renderer side of the host-owned versioned workspace manifest:
 *  - `loadWorkspaceManifest(projectId)` — reads the host manifest and rebuilds
 *    the workspace topology from its portable projection (called by
 *    `useEditorPersistence`'s restore flow, which owns the editor open-files
 *    loop the manifest topology is reconciled against).
 *  - `useWorkspaceManifestSync(projectId)` — the React hook mounted alongside
 *    `useEditorPersistence` in `WorkspaceLayout`. Subscribes to the portable
 *    slice of the workspace/editor/acp/terminal stores and debounced-writes
 *    the manifest back through `workspaceManifestApi` (≥500ms coalesce).
 *    On `Updated` it advances `basedRevision`; on `Conflict` it surfaces a
 *    recoverable UI (never auto-retries the same `basedRevision`); on
 *    `success: false` it logs via `logFrontendError`.
 *  - `resolveManifestConflict(projectId, action)` — the three-option
 *    reload/overwrite/dismiss resolution path the conflict banner calls.
 *
 * The manifest is a portable projection: it carries topology (terminalIds +
 * editorIds + activeTabId), terminal descriptors, editor paths, the active
 * pane, and the focused ACP session. It NEVER carries the raw CAP-3 claim
 * credential (the opaque `claimHandle` is `terminal.id`), viewport/window
 * state, env vars, or renderer-only tab bodies (browser/git/agent-chat/
 * git-history). The renderer-local `persistenceApi` layer continues to own
 * that renderer-specific state; the manifest layers ON TOP.
 */

import type {
  EditorDescriptor,
  LeafNode as PortableLeafNode,
  PaneNode as PortablePaneNode,
  TerminalDescriptor,
  WorkspaceManifest
} from '@shared/types/workspace-manifest.types'
import { useEffect } from 'react'
import { isTerminalRestoreInProgress } from '@/hooks/useTerminalAutoSave'
import { logFrontendError } from '@/lib/log-api'
import { workspaceManifestApi } from '@/lib/workspace-manifest-api'
import { useAcpStore } from '@/stores/acp-store'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  isManifestRestoreInProgressFor,
  useWorkspaceManifestSyncStore
} from '@/stores/workspace-manifest-sync-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { editorTabId, terminalTabId, useWorkspaceStore } from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'

/** Debounce window for coalesced manifest writes (mirrors useEditorPersistence). */
const MANIFEST_WRITE_DEBOUNCE_MS = 500

/**
 * Caller-supplied opaque identity for manifest writes (Epic 2 wires real
 * auth). Per-renderer-session so a second client stamping the same project
 * surfaces as a distinct writer in the conflict body.
 */
let updateIdentityCache: string | null = null
function getUpdateIdentity(): string {
  if (updateIdentityCache === null) {
    updateIdentityCache = `renderer-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  }
  return updateIdentityCache
}

/**
 * Generate a leaf id without relying on `crypto.randomUUID()` (undefined in
 * non-HTTPS web mode, e.g. an `http://` dev preview).
 */
function generateLeafId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `leaf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id]
  return node.children.flatMap(collectLeafIds)
}

/**
 * Build the portable manifest from the current renderer state. The host owns
 * `revision`; the renderer sends a placeholder (the host overwrites it on a
 * successful write and returns the new revision in `WriteOutcome.Updated`).
 */
export function buildPortableManifest(projectId: string): WorkspaceManifest {
  const workspaceState = useWorkspaceStore.getState()
  const editorState = useEditorStore.getState()
  const terminalState = useTerminalStore.getState()
  const acpState = useAcpStore.getState()

  const terminals: TerminalDescriptor[] = terminalState.terminals
    .filter((terminal) => terminal.projectId === projectId)
    .map((terminal) => {
      const descriptor: TerminalDescriptor = {
        terminalId: terminal.id,
        projectId: terminal.projectId,
        shell: terminal.shell,
        cwd: terminal.cwd ?? '',
        name: terminal.name,
        // The opaque claimHandle lets a post-restore CAP-3 reclaim path pair
        // back to the in-memory claim. The host never dereferences it.
        claimHandle: terminal.id
      }
      if (terminal.worktreeId) {
        descriptor.worktreeId = terminal.worktreeId
      }
      return descriptor
    })

  const editors: EditorDescriptor[] = []
  editorState.openFiles.forEach((_file, filePath) => {
    editors.push({ editorId: editorTabId(filePath), filePath })
  })

  return {
    projectId,
    // Host owns revision; renderer sends 0 as a placeholder (host overwrites).
    revision: 0,
    updateIdentity: getUpdateIdentity(),
    updatedAt: Date.now(),
    topology: serializeTopologyForManifest(workspaceState.root),
    activePaneId: workspaceState.activePaneId,
    focusedSessionId: acpState.activeSessionId,
    terminals,
    editors
  }
}

/** Serialize the workspace tree into the manifest's portable PaneNode shape. */
function serializeTopologyForManifest(node: PaneNode): PortablePaneNode {
  if (node.type === 'leaf') {
    const terminalIds: string[] = []
    const editorIds: string[] = []
    for (const tab of node.tabs) {
      if (tab.type === 'terminal') {
        terminalIds.push(tab.terminalId)
      } else if (tab.type === 'editor') {
        editorIds.push(tab.id)
      }
      // browser / git / agent-chat / git-history: dropped (non-portable).
    }
    return {
      type: 'leaf',
      id: node.id,
      terminalIds,
      editorIds,
      activeTabId: node.activeTabId
    }
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializeTopologyForManifest),
    sizes: node.sizes
  }
}

/**
 * Rebuild a workspace `PaneNode` tree from the manifest's portable topology,
 * sanitizing dangling refs: terminalIds/editorIds not present in the
 * manifest's `terminals`/`editors` arrays are dropped (warn-logged); an
 * `activePaneId` pointing at a missing leaf falls back to the first leaf; a
 * `focusedSessionId` unknown to the acp-store is left null. Returns the
 * rebuilt root, the resolved activePaneId, and the resolved focusedSessionId.
 */
export function rebuildTopologyFromManifest(manifest: WorkspaceManifest): {
  root: PaneNode
  activePaneId: string | null
  focusedSessionId: string | null
} {
  const terminalsByTerminalId = new Map(
    manifest.terminals.map((descriptor) => [descriptor.terminalId, descriptor] as const)
  )
  const editorsByEditorId = new Map(
    manifest.editors.map((descriptor) => [descriptor.editorId, descriptor] as const)
  )

  const buildLeaf = (portable: PortableLeafNode): LeafNode => {
    const tabs: WorkspaceTab[] = []
    for (const terminalId of portable.terminalIds) {
      const descriptor = terminalsByTerminalId.get(terminalId)
      if (!descriptor) {
        console.warn(
          `[workspace-manifest] dropping dangling terminalId "${terminalId}" from leaf "${portable.id}"`
        )
        continue
      }
      tabs.push({ type: 'terminal', id: terminalTabId(terminalId), terminalId })
    }
    for (const editorId of portable.editorIds) {
      const descriptor = editorsByEditorId.get(editorId)
      if (!descriptor) {
        console.warn(
          `[workspace-manifest] dropping dangling editorId "${editorId}" from leaf "${portable.id}"`
        )
        continue
      }
      tabs.push({
        type: 'editor',
        id: editorTabId(descriptor.filePath),
        filePath: descriptor.filePath
      })
    }
    let activeTabId = portable.activeTabId ?? null
    if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs.length > 0 ? tabs[0].id : null
    }
    return { type: 'leaf', id: portable.id, tabs, activeTabId }
  }

  const buildNode = (portable: PortablePaneNode): PaneNode => {
    if (portable.type === 'leaf') {
      return buildLeaf(portable)
    }
    const split: SplitNode = {
      type: 'split',
      id: portable.id,
      direction: portable.direction,
      children: portable.children.map(buildNode),
      sizes: portable.sizes
    }
    return split
  }

  let root: PaneNode
  if (manifest.topology) {
    root = buildNode(manifest.topology)
  } else {
    root = { type: 'leaf', id: generateLeafId(), tabs: [], activeTabId: null }
  }

  const leafIds = collectLeafIds(root)
  // Patch 8: if the rebuilt tree has no leaves (e.g. an empty split node),
  // replace with a fresh empty leaf so loadProjectWorkspace gets a valid root.
  if (leafIds.length === 0) {
    root = { type: 'leaf', id: generateLeafId(), tabs: [], activeTabId: null }
  }
  let activePaneId = manifest.activePaneId ?? null
  if (!activePaneId || !collectLeafIds(root).includes(activePaneId)) {
    if (activePaneId) {
      console.warn(
        `[workspace-manifest] dangling activePaneId "${activePaneId}", falling back to first leaf`
      )
    }
    activePaneId = leafIds[0] ?? null
  }

  let focusedSessionId = manifest.focusedSessionId ?? null
  if (focusedSessionId) {
    const sessions = useAcpStore.getState().sessions
    if (!sessions || !(focusedSessionId in sessions)) {
      console.warn(
        `[workspace-manifest] focusedSessionId "${focusedSessionId}" unknown to acp-store, leaving null`
      )
      focusedSessionId = null
    }
  }

  return { root, activePaneId, focusedSessionId }
}

/**
 * Load the host manifest for a project and rebuild the workspace topology
 * from its portable projection. Returns `true` when a manifest was found and
 * restored (topology + active pane + focused session + basedRevision set),
 * `false` when no manifest exists or the load failed (caller falls back to
 * the renderer-local `editorStateKey.paneLayout` path or a fresh layout).
 *
 * The caller MUST wrap this call in `setManifestRestoreInProgress(projectId,
 * true/false)` so the writer cancels pending writes during the tree rebuild.
 * This function does not set the guard itself — the caller owns the window to
 * avoid nested-clear races when the restore flow wraps a broader region.
 */
export async function loadWorkspaceManifest(projectId: string): Promise<boolean> {
  if (!projectId) return false
  try {
    const result = await workspaceManifestApi.getManifest(projectId)

    if (!result.success) {
      // Transport failure (e.g. web-mode NETWORK_ERROR). Degrade gracefully:
      // log and let the caller fall back to renderer-local state / fresh layout.
      void logFrontendError({
        source: 'workspace-manifest-sync',
        message: `getManifest failed for project ${projectId}: ${result.code} ${result.error}`
      })
      useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, null)
      return false
    }

    if (!result.data) {
      // Fresh workspace: no manifest exists yet. Next write uses basedRevision null.
      useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, null)
      return false
    }

    const manifest = result.data
    const { root, activePaneId, focusedSessionId } = rebuildTopologyFromManifest(manifest)
    useWorkspaceStore.getState().loadProjectWorkspace(root, activePaneId)
    useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, manifest.revision)
    if (focusedSessionId) {
      useAcpStore.getState().setActiveSession(focusedSessionId)
    }

    // Seed editor openFiles for manifest editor descriptors. On a cross-client
    // cold restore (no renderer-local editorStateKey), the open-files loop in
    // useEditorPersistence iterated over an empty persisted.openFiles, so the
    // manifest's editor tabs would reference filePaths whose EditorFileState
    // is undefined. Mirror the existing open-files loop: openFile reads from
    // disk; a missing/unreadable file is swallowed (the tab still references
    // the path and opens on demand when clicked).
    const editorStore = useEditorStore.getState()
    await Promise.all(
      manifest.editors.map((descriptor) => {
        if (editorStore.openFiles.has(descriptor.filePath)) return Promise.resolve()
        return editorStore.openFile(descriptor.filePath).catch(() => {
          // File may not exist on this client (cross-client); the editor tab
          // still references the path. Not an error — degrade gracefully.
        })
      })
    )

    return true
  } catch (error) {
    void logFrontendError({
      source: 'workspace-manifest-sync',
      message: `loadWorkspaceManifest threw for project ${projectId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    })
    useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, null)
    return false
  }
}

/**
 * Perform a revision-checked manifest write. Fire-and-forget from the store
 * mutation's perspective: store mutations NEVER await this. On `Updated` the
 * `basedRevision` advances; on `Conflict` a `pendingConflict` is set in the
 * sync store (the banner surfaces it); on `success: false` the failure is
 * logged via `logFrontendError`. Skips while a manifest or terminal restore
 * is in flight, or while a conflict is already pending (user must resolve).
 *
 * Returns the outcome so callers (e.g. the overwrite resolution path) can
 * decide whether to re-surface a cleared conflict on failure.
 */
export type ManifestWriteResult = 'updated' | 'conflict' | 'failed' | 'skipped'

export async function performManifestWrite(projectId: string): Promise<ManifestWriteResult> {
  if (!projectId) return 'skipped'
  if (isManifestRestoreInProgressFor(projectId) || isTerminalRestoreInProgress()) return 'skipped'
  if (useWorkspaceManifestSyncStore.getState().hasPendingConflict(projectId)) return 'skipped'

  try {
    const manifest = buildPortableManifest(projectId)
    const basedRevision = useWorkspaceManifestSyncStore.getState().getBasedRevision(projectId)
    const result = await workspaceManifestApi.writeManifest(projectId, basedRevision, manifest)

    // Patch 5: a restore may have started during the in-flight write. Re-check
    // and drop the outcome to avoid clobbering the just-restored state (the
    // next scheduleWrite after restore clears will re-propose).
    if (isManifestRestoreInProgressFor(projectId) || isTerminalRestoreInProgress()) {
      return 'skipped'
    }

    // Patch 4: null-check result.data before accessing outcome.status. Split
    // into two checks so TypeScript narrows correctly (checking `!result.success`
    // first narrows to the error variant with `code`/`error`; the second check
    // guards against a contract-violating success-but-null-data response).
    if (!result.success) {
      void logFrontendError({
        source: 'workspace-manifest-sync',
        message: `writeManifest failed for project ${projectId}: ${result.code} ${result.error}`
      })
      return 'failed'
    }

    if (!result.data) {
      void logFrontendError({
        source: 'workspace-manifest-sync',
        message: `writeManifest returned success but no data for project ${projectId}`
      })
      return 'failed'
    }

    const outcome = result.data
    if (outcome.status === 'updated') {
      useWorkspaceManifestSyncStore.getState().advanceBasedRevision(projectId, outcome.revision)
      // Patch 2: info-level log on Updated (projectId + new revision; not the
      // manifest body).
      console.info(
        `[workspace-manifest] write updated for project ${projectId}: revision ${outcome.revision}`
      )
      return 'updated'
    }

    if (outcome.status === 'conflict') {
      // Conflict: success-body variant, not an error. Surface recoverable UI.
      // Never auto-retry the same basedRevision (would loop).
      console.warn(
        `[workspace-manifest] conflict for project ${projectId}: host at revision ${outcome.currentRevision}` +
          (outcome.currentUpdateIdentity ? ` (writer: ${outcome.currentUpdateIdentity})` : '')
      )
      useWorkspaceManifestSyncStore.getState().setPendingConflict({
        projectId,
        currentRevision: outcome.currentRevision,
        currentUpdatedAt: outcome.currentUpdatedAt,
        currentUpdateIdentity: outcome.currentUpdateIdentity
      })
      return 'conflict'
    }

    // P7: unknown outcome.status (future variant or malformed host response).
    // Log and do not surface a malformed conflict banner.
    void logFrontendError({
      source: 'workspace-manifest-sync',
      message: `writeManifest returned unknown outcome status "${String(
        (outcome as { status?: string }).status
      )}" for project ${projectId}`
    })
    return 'failed'
  } catch (error) {
    // P6: unhandled rejection guard. Log and leave the store in a clean state.
    void logFrontendError({
      source: 'workspace-manifest-sync',
      message: `performManifestWrite threw for project ${projectId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    })
    return 'failed'
  }
}

/**
 * Resolve a surfaced manifest conflict. Three actions cover the matrix:
 *  - `reload` — host wins: re-restore from the host manifest.
 *  - `overwrite` — local wins: retry the write with the conflict's
 *    `currentRevision` as the new basedRevision (so the host accepts it).
 *  - `dismiss` — local wins, accept the host's revision as the new base
 *    without writing (the next local change proposes against it).
 */
export async function resolveManifestConflict(
  projectId: string,
  action: 'reload' | 'overwrite' | 'dismiss'
): Promise<void> {
  const conflict = useWorkspaceManifestSyncStore.getState().pendingConflict
  if (!conflict || conflict.projectId !== projectId) return

  if (action === 'reload') {
    useWorkspaceManifestSyncStore.getState().setPendingConflict(null)
    useWorkspaceManifestSyncStore.getState().setManifestRestoreInProgress(projectId, true)
    try {
      await loadWorkspaceManifest(projectId)
    } catch (error) {
      // P6: reload threw — log and leave the workspace as-is (local state wins).
      void logFrontendError({
        source: 'workspace-manifest-sync',
        message: `reload (loadWorkspaceManifest) threw for project ${projectId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
    } finally {
      useWorkspaceManifestSyncStore.getState().setManifestRestoreInProgress(projectId, false)
    }
    return
  }

  if (action === 'overwrite') {
    useWorkspaceManifestSyncStore.getState().setPendingConflict(null)
    useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, conflict.currentRevision)
    const writeResult = await performManifestWrite(projectId)
    // If the write failed or was skipped, re-surface the original conflict so
    // the user can retry (otherwise the banner is gone with no recovery path).
    // On 'conflict' a new pendingConflict was already set by
    // performManifestWrite (rare race); on 'updated' the write succeeded.
    if (writeResult === 'failed' || writeResult === 'skipped') {
      useWorkspaceManifestSyncStore.getState().setPendingConflict(conflict)
    }
    return
  }

  if (action === 'dismiss') {
    useWorkspaceManifestSyncStore.getState().setPendingConflict(null)
    useWorkspaceManifestSyncStore.getState().setBasedRevision(projectId, conflict.currentRevision)
    return
  }

  // P7: unknown action (TypeScript should prevent this, but a runtime caller
  // could pass anything). Log and clear the conflict so the user isn't stuck.
  void logFrontendError({
    source: 'workspace-manifest-sync',
    message: `resolveManifestConflict received unknown action "${String(action)}" for project ${projectId}`
  })
  useWorkspaceManifestSyncStore.getState().setPendingConflict(null)
}

/** True iff the portable-relevant slice of the terminal store changed. */
function terminalsPortableChanged(next: Terminal[], prev: Terminal[]): boolean {
  if (next.length !== prev.length) return true
  const prevById = new Map(prev.map((terminal) => [terminal.id, terminal] as const))
  for (const terminal of next) {
    const previous = prevById.get(terminal.id)
    if (!previous) return true
    if (
      terminal.name !== previous.name ||
      terminal.shell !== previous.shell ||
      terminal.cwd !== previous.cwd ||
      terminal.worktreeId !== previous.worktreeId ||
      terminal.projectId !== previous.projectId
    ) {
      return true
    }
  }
  return false
}

/**
 * The sync hook. Mount alongside `useEditorPersistence(activeProjectId)` in
 * `WorkspaceLayout`. Subscribes to the portable slice of the workspace /
 * editor (open-files-only) / acp (activeSessionId only) / terminal
 * (id/name/shell/cwd/worktreeId only) stores and debounced-writes the
 * manifest. Cancels pending writes while a manifest or terminal restore is
 * in flight — but remembers the pending change (Patch 13) and reschedules
 * when the restore clears (via a sync-store subscription) so the last change
 * before restore is not lost. On project switch cleanup, flushes any
 * pending write best-effort (Patch 14).
 */
export function useWorkspaceManifestSync(projectId: string): void {
  // P4: capture projectId in the effect closure (deps: [projectId]) so the
  // timer callback writes against the project that scheduled the write, not
  // the (possibly already-switched) latest prop. No ref needed.
  useEffect(() => {
    if (!projectId) return
    let writeTimer: ReturnType<typeof setTimeout> | null = null
    // Patch 13: tracks a change that was cancelled because a restore was
    // in flight. Re-fired when the restore clears.
    let pendingChange = false

    const fireWrite = (): void => {
      writeTimer = null
      if (isManifestRestoreInProgressFor(projectId) || isTerminalRestoreInProgress()) {
        // Restore started during the debounce. Remember the pending change;
        // the sync-store subscription below re-fires when restore clears.
        pendingChange = true
        return
      }
      pendingChange = false
      void performManifestWrite(projectId).catch(() => {
        // P6: best-effort fire-and-forget — performManifestWrite logs
        // internally; never let an unhandled rejection escape the timer.
      })
    }

    const scheduleWrite = (): void => {
      if (isManifestRestoreInProgressFor(projectId) || isTerminalRestoreInProgress()) {
        // Can't schedule now — a restore is in flight. Remember the change.
        pendingChange = true
        return
      }
      pendingChange = false
      if (writeTimer) clearTimeout(writeTimer)
      writeTimer = setTimeout(fireWrite, MANIFEST_WRITE_DEBOUNCE_MS)
    }

    const unsubWorkspace = useWorkspaceStore.subscribe((state, prevState) => {
      if (state.root === prevState.root && state.activePaneId === prevState.activePaneId) return
      scheduleWrite()
    })
    const unsubEditor = useEditorStore.subscribe((state, prevState) => {
      // open-files-only (NOT scroll/cursor/draft — those are renderer-local).
      if (state.openFiles === prevState.openFiles) return
      scheduleWrite()
    })
    const unsubAcp = useAcpStore.subscribe((state, prevState) => {
      if (state.activeSessionId === prevState.activeSessionId) return
      scheduleWrite()
    })
    const unsubTerminal = useTerminalStore.subscribe((state, prevState) => {
      if (state.terminals === prevState.terminals) return
      if (!terminalsPortableChanged(state.terminals, prevState.terminals)) return
      scheduleWrite()
    })

    // Patch 13: when a manifest restore clears (true→false for this project)
    // and we have a pending change, reschedule the write so the last change
    // before restore is not lost.
    const unsubSync = useWorkspaceManifestSyncStore.subscribe((state, prevState) => {
      const wasRestoring = prevState.manifestRestoreInProgressByProject[projectId] === true
      const isRestoring = state.manifestRestoreInProgressByProject[projectId] === true
      if (wasRestoring && !isRestoring && pendingChange) {
        pendingChange = false
        scheduleWrite()
      }
    })

    return () => {
      // Patch 14: flush the pending write on project switch cleanup so the
      // old project's last workspace change is not lost from the manifest.
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
        void performManifestWrite(projectId).catch(() => {
          // P6: best-effort fire-and-forget — performManifestWrite logs
          // internally; never let an unhandled rejection escape the timer.
        })
      }
      unsubWorkspace()
      unsubEditor()
      unsubAcp()
      unsubTerminal()
      unsubSync()
    }
  }, [projectId])
}
