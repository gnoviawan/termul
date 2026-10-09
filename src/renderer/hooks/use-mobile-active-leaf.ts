import { useEffect, useMemo, useRef } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, PaneNode } from '@/types/workspace.types'

export interface MobileActiveLeafResolution {
  /** The leaf to render. `null` only for a degenerate tree that has no leaf. */
  leaf: LeafNode | null
  /** True when `activePaneId` matched no leaf and the first leaf was used. */
  fallback: boolean
}

/**
 * Which leaf of a (possibly split) pane tree the mobile web shell renders.
 *
 * The rule is the one `MobileChatShell`'s `activeTab` selector already uses:
 * the leaf whose id is `activePaneId`, else the first leaf of the tree. Pure
 * and read-only. It never touches the tree, so a pane tree synced from desktop
 * keeps its shape and its PTYs.
 */
export function resolveMobileActiveLeaf(
  root: PaneNode,
  activePaneId: string | null | undefined
): MobileActiveLeafResolution {
  const leaves = getAllLeafPanes(root)
  const active = leaves.find((leaf) => leaf.id === activePaneId)
  if (active) return { leaf: active, fallback: false }
  return { leaf: leaves[0] ?? null, fallback: true }
}

/**
 * Collapse the workspace pane tree to its active leaf on the mobile web shell
 * (UX FIX 11: a split synced from desktop must not render split on a phone).
 *
 * Returns `null` when disabled (desktop, Tauri) so callers keep their existing
 * node. Read-only: it reads `root` / `activePaneId` through selectors and never
 * calls a workspace-store action, so it cannot change the shared tree, the
 * active or fullscreen pane, or any terminal. When `activePaneId` matches no
 * leaf it falls back to the first leaf and logs one warning per distinct
 * unresolved id.
 */
export function useMobileActiveLeaf(enabled: boolean): LeafNode | null {
  // Selectors return a constant while disabled so desktop does not re-render
  // on pane changes it never uses.
  const root = useWorkspaceStore((state) => (enabled ? state.root : null))
  const activePaneId = useWorkspaceStore((state) => (enabled ? state.activePaneId : null))

  const resolution = useMemo(
    () => (root ? resolveMobileActiveLeaf(root, activePaneId) : null),
    [root, activePaneId]
  )

  const warnedIdsRef = useRef<Set<string>>(new Set())
  const unresolvedId = resolution?.fallback ? (activePaneId ?? '') : null

  useEffect(() => {
    if (unresolvedId === null || warnedIdsRef.current.has(unresolvedId)) return
    warnedIdsRef.current.add(unresolvedId)
    void logFrontendError({
      level: 'warn',
      source: 'useMobileActiveLeaf',
      message: `activePaneId "${unresolvedId}" matches no leaf; mobile shell falls back to the first leaf`
    })
  }, [unresolvedId])

  return resolution?.leaf ?? null
}
