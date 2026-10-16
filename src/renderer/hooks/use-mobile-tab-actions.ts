import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { returnToWorkspaceRoute } from '@/lib/workspace-route'
import { closeWorkspaceTab } from '@/lib/workspace-tab-close'
import { getAllLeafPanes, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'

/** A workspace tab with the leaf pane that holds it. */
export interface PaneTabEntry {
  tab: WorkspaceTab
  paneId: string
}

export interface MobileTabActionsOptions {
  /**
   * Close a terminal tab. Returns `true` only when it opened the close confirm.
   */
  onCloseTerminal?: (terminalId: string, tabId: string) => boolean
  /**
   * Close an editor tab through the dirty-file guard (WorkspaceLayout
   * `handleCloseEditorTab` semantics) so mobile closes never silently discard
   * unsaved changes. Returns `true` only when it opened the confirm.
   */
  onCloseEditorTab?: (filePath: string) => boolean
}

export interface MobileTabActions {
  /** Every pane tab across every leaf, in tree order. */
  paneTabs: PaneTabEntry[]
  /** Activate a pane tab (leaves fullscreen and returns to the workspace route as needed). */
  selectTab: (paneId: string, tabId: string) => void
  /**
   * Close a tab through its guarded path. Returns `true` only when the close
   * opened a confirm (a terminal, a dirty editor) that the caller should hand
   * off to.
   */
  closePaneTab: (tab: WorkspaceTab) => boolean
}

/**
 * Select and close routing shared by the mobile drawer lists and the header ⋯
 * sheet. Moved unchanged from the drawer's former Open
 * section so every entry point agrees on fullscreen, route and guard handling.
 */
export function useMobileTabActions({
  onCloseTerminal,
  onCloseEditorTab
}: MobileTabActionsOptions = {}): MobileTabActions {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // ALL pane tabs across every leaf (terminal, editor, git, git-history,
  // browser, agent-chat, canvas). Derive via useMemo from the stable `root`
  // reference so the wrapper objects are only rebuilt when the tree changes.
  const workspaceRoot = useWorkspaceStore((s) => s.root)
  const paneTabs = useMemo(() => {
    const leaves = getAllLeafPanes(workspaceRoot)
    return leaves.flatMap((leaf) => (leaf.tabs ?? []).map((t) => ({ tab: t, paneId: leaf.id })))
  }, [workspaceRoot])

  // Select any pane tab. Agent-chat selection routes through setActiveTab
  // which also navigates to the chat session.
  const selectTab = useCallback(
    (paneId: string, tabId: string): void => {
      const workspace = useWorkspaceStore.getState()
      // Off the workspace route (the same test WorkspaceLayout uses to decide
      // whether to mount the panes) a non-chat tab has no route of its own, so
      // return to the workspace once the tab is active. Chat rows already land
      // on /c/<id> through setActiveTab.
      const selectedType = paneTabs.find(({ tab }) => tab.id === tabId)?.tab.type
      const isChatRow = selectedType === 'agent-chat'
      const activate = (): void => {
        const current = useWorkspaceStore.getState()
        // Fullscreen pins activePaneId to its own leaf (resolveActivePaneId), so
        // a tab chosen in any other leaf would update that leaf's active tab yet
        // leave the mobile view on the fullscreen one (a dead tap). Fullscreen is
        // per-client view state, so leave it (existing store action) when the row
        // belongs to a different leaf; a row in the fullscreen leaf keeps it.
        if (current.fullscreenPaneId && current.fullscreenPaneId !== paneId) {
          current.clearFullscreenPane()
        }
        current.setActiveTab(paneId, tabId)
        if (!isChatRow) returnToWorkspaceRoute(pathname, navigate)
      }
      if (workspace.activePaneId !== paneId) {
        // Defer tab activation until pane is active. The return navigation
        // follows the activation inside the same frame callback, so the
        // workspace route never paints the previously active leaf first.
        requestAnimationFrame(activate)
      } else {
        activate()
      }
    },
    [paneTabs, pathname, navigate]
  )

  const closePaneTab = useCallback(
    (tab: WorkspaceTab): boolean =>
      closeWorkspaceTab(
        tab,
        {
          terminal: (terminalTab) =>
            onCloseTerminal?.(terminalTab.terminalId, terminalTab.id) ?? false,
          editor: (editorTab) => {
            if (onCloseEditorTab) return onCloseEditorTab(editorTab.filePath)
            useWorkspaceStore.getState().removeTab(editorTab.id)
            return false
          }
        },
        'useMobileTabActions.closePaneTab'
      ),
    [onCloseTerminal, onCloseEditorTab]
  )

  return { paneTabs, selectTab, closePaneTab }
}
