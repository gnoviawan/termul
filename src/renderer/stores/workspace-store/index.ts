/**
 * Workspace store — composition root. Composes the pane/tabs/sync action slices
 * from ./slices over the initial single-leaf layout and re-exports the full
 * public surface of the former single-file store.
 */

import { create } from 'zustand'
import { createPaneSlice } from './slices/pane'
import { createSyncSlice } from './slices/sync'
import { createTabsSlice } from './slices/tabs'
import { createLeaf, editorTabId, makeBrowserTabId, terminalTabId } from './tree'
import type { WorkspaceState } from './types'

export const useWorkspaceStore = create<WorkspaceState>((...a) => {
  const initialLeaf = createLeaf()

  return {
    root: initialLeaf,
    activePaneId: initialLeaf.id,
    fullscreenPaneId: null,
    agentLauncherPaneId: null,
    agentBrowserPaneId: null,

    ...createPaneSlice(...a),
    ...createTabsSlice(...a),
    ...createSyncSlice(...a)
  }
})

export * from './selectors'
export {
  agentChatTabId,
  canvasTabId,
  findPaneById,
  findPaneContainingTab,
  findParentSplit,
  flattenSameDirection,
  getAllLeafPanes,
  gitHistoryTabId,
  gitTabId,
  normalizePaneTree
} from './tree'
export type { AddTabOptions, SplitPaneOptions, WorkspaceState, WorkspaceTab } from './types'
export { editorTabId, makeBrowserTabId as browserTabId, terminalTabId }
