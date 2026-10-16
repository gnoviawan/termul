import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { findPaneById } from '@/stores/workspace-store/tree'
import type { PaneNode } from '@/types/workspace.types'

/** What the main area shows, as far as the top row is concerned. */
export type TopRowMode = 'panes' | 'ssh' | 'fallback'

/** Who renders the window controls (Windows/Linux desktop). */
export type TopRowControlsOwner = 'pane' | 'ssh-header' | 'fallback-bar'

/** Who renders the Show side panel button while the Side panel is hidden. */
export type TopRowShowPanelOwner = 'pane' | 'ssh-header' | 'fallback-bar'

export interface TopRowRoles {
  /** Pane leaves whose tab bar touches the top edge of the main area. */
  topEdgeLeafIds: ReadonlySet<string>
  /** The top-edge leaf that is rightmost (it owns the controls in `pane` mode). */
  rightmostLeafId: string | null
  /** The top-edge leaf that is leftmost (it owns the Show side panel button). */
  leftmostLeafId: string | null
  controlsOwner: TopRowControlsOwner
  /** Owner of the Show side panel button (the leftmost leaf's tab bar in `pane` mode). */
  showPanelOwner: TopRowShowPanelOwner
}

export interface TopRowPlatform {
  /** `data-tauri-drag-region` is rendered on empty space. */
  dragRegions: boolean
  /** In-app minimize / maximize / close (Tauri on Windows and Linux). */
  windowControls: boolean
  /** The native macOS traffic lights need clearance (Tauri on macOS). */
  trafficLights: boolean
}

export interface PaneTopRowRole {
  topEdge: boolean
  /** Leftmost top-edge pane: its tab bar starts where the Side panel edge was. */
  leftEdge: boolean
  dragRegion: boolean
  windowControls: boolean
}

/**
 * Leaves that touch the top edge. A `horizontal` split lays its children out
 * left to right, so every child touches it; a `vertical` split stacks them,
 * so only the first does.
 */
export function getTopEdgeLeafIds(root: PaneNode): Set<string> {
  if (root.type === 'leaf') return new Set([root.id])
  if (root.direction === 'horizontal') {
    const ids = new Set<string>()
    for (const child of root.children) {
      for (const id of getTopEdgeLeafIds(child)) ids.add(id)
    }
    return ids
  }
  const first = root.children[0]
  return first ? getTopEdgeLeafIds(first) : new Set()
}

/** The rightmost top-edge leaf: last child of a horizontal split, first of a vertical one. */
export function getRightmostTopEdgeLeafId(root: PaneNode): string | null {
  if (root.type === 'leaf') return root.id
  const child =
    root.direction === 'horizontal' ? root.children[root.children.length - 1] : root.children[0]
  return child ? getRightmostTopEdgeLeafId(child) : null
}

/** The leftmost top-edge leaf: the first child, whatever the split direction. */
export function getLeftmostTopEdgeLeafId(root: PaneNode): string | null {
  if (root.type === 'leaf') return root.id
  const child = root.children[0]
  return child ? getLeftmostTopEdgeLeafId(child) : null
}

/**
 * The single place that decides who owns the window controls and the Show
 * side panel button. A fullscreen pane is the whole tree. SSH and the fallback
 * bar carry no pane roles, so each renders the button in its own bar.
 */
export function selectTopRowRoles({
  root,
  fullscreenPaneId,
  mode
}: {
  root: PaneNode
  fullscreenPaneId: string | null
  mode: TopRowMode
}): TopRowRoles {
  if (mode === 'ssh') {
    return {
      topEdgeLeafIds: new Set(),
      rightmostLeafId: null,
      leftmostLeafId: null,
      controlsOwner: 'ssh-header',
      showPanelOwner: 'ssh-header'
    }
  }
  if (mode === 'fallback') {
    return {
      topEdgeLeafIds: new Set(),
      rightmostLeafId: null,
      leftmostLeafId: null,
      controlsOwner: 'fallback-bar',
      showPanelOwner: 'fallback-bar'
    }
  }
  const effective = resolveEffectiveRoot(root, fullscreenPaneId)
  return {
    topEdgeLeafIds: getTopEdgeLeafIds(effective),
    rightmostLeafId: getRightmostTopEdgeLeafId(effective),
    leftmostLeafId: getLeftmostTopEdgeLeafId(effective),
    controlsOwner: 'pane',
    showPanelOwner: 'pane'
  }
}

function resolveEffectiveRoot(root: PaneNode, fullscreenPaneId: string | null): PaneNode {
  if (!fullscreenPaneId) return root
  const pane = findPaneById(root, fullscreenPaneId)
  return pane?.type === 'leaf' ? pane : root
}

/** Reads the platform at call time (tests flip `isTauriContext`). Web is all false. */
export function getTopRowPlatform(): TopRowPlatform {
  const desktop = isTauriContext()
  return {
    dragRegions: desktop,
    windowControls: desktop && !isMac,
    trafficLights: desktop && isMac
  }
}

/** The role one pane's tab bar plays in the top row. */
export function paneTopRowRole(
  roles: TopRowRoles,
  platform: TopRowPlatform,
  paneId: string
): PaneTopRowRole {
  const topEdge = roles.topEdgeLeafIds.has(paneId)
  return {
    topEdge,
    leftEdge: topEdge && roles.leftmostLeafId === paneId,
    dragRegion: topEdge && platform.dragRegions,
    windowControls:
      topEdge &&
      roles.controlsOwner === 'pane' &&
      roles.rightmostLeafId === paneId &&
      platform.windowControls
  }
}
