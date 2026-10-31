import { toast } from 'sonner'
import { useEditorStore } from '@/stores/editor-store'
import { editorTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * The generic "Save" in an unsaved-changes prompt cannot save a file with an
 * unresolved draft conflict (it has two candidate buffers and `saveFile`
 * refuses). Instead of failing silently, reveal that file's tab so the
 * conflict banner is visible and ask the user to resolve it first.
 *
 * Returns true when a conflicted file was found (caller must not save or
 * close anything); false when none of `filePaths` has a conflict.
 */
export function blockSaveOnDraftConflict(filePaths: Iterable<string>): boolean {
  const { openFiles } = useEditorStore.getState()
  for (const filePath of filePaths) {
    const file = openFiles.get(filePath)
    if (file?.kind !== 'text' || !file.draftConflict) continue

    const workspace = useWorkspaceStore.getState()
    const tabId = editorTabId(filePath)
    const pane = findPaneContainingTab(workspace.root, tabId)
    if (pane) {
      // Fullscreen is per-client view state: a conflicted tab in another pane
      // would stay hidden behind the fullscreen one (see use-mobile-tab-actions).
      if (workspace.fullscreenPaneId && workspace.fullscreenPaneId !== pane.id) {
        workspace.clearFullscreenPane()
      }
      workspace.setActivePane(pane.id)
      workspace.setActiveTab(pane.id, tabId)
    }
    toast.warning('Resolve the draft conflict first')
    return true
  }
  return false
}
