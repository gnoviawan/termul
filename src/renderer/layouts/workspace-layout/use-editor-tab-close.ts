import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { fileNeedsAttention } from '@/lib/editor-file-attention'
import { useEditorStore } from '@/stores/editor-store'
import { editorTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { blockSaveOnDraftConflict } from './draft-conflict-save-guard'

/** Single editor-tab close flow with the dirty-file confirm. */
export function useEditorTabClose() {
  const [dirtyCloseFilePath, setDirtyCloseFilePath] = useState<string | null>(null)

  // Dirty file close handlers. Returns true only when it opened the dirty-file
  // confirm (see `handleCloseTerminal`).
  const handleCloseEditorTab = useCallback((filePath: string): boolean => {
    const fileState = useEditorStore.getState().openFiles.get(filePath)
    if (fileState?.operationStatus === 'saving' || fileState?.operationStatus === 'reloading') {
      return false
    }
    if (fileNeedsAttention(fileState)) {
      setDirtyCloseFilePath(filePath)
      return true
    }
    useEditorStore.getState().closeFileIfIdle(filePath)
    useWorkspaceStore.getState().removeTab(editorTabId(filePath))
    return false
  }, [])

  const handleSaveThenClose = useCallback(async () => {
    if (dirtyCloseFilePath) {
      // A draft conflict cannot be saved from here: reveal it, keep the tab.
      if (blockSaveOnDraftConflict([dirtyCloseFilePath])) {
        setDirtyCloseFilePath(null)
        return
      }
      const saved = await useEditorStore.getState().saveFile(dirtyCloseFilePath)
      if (!saved) {
        toast.error('Failed to save file. Changes were not discarded.')
        setDirtyCloseFilePath(null)
        return
      }
      useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleDiscardAndClose = useCallback(() => {
    if (dirtyCloseFilePath) {
      useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleCancelDirtyClose = useCallback(() => {
    setDirtyCloseFilePath(null)
  }, [])

  return {
    dirtyCloseFilePath,
    handleCloseEditorTab,
    handleSaveThenClose,
    handleDiscardAndClose,
    handleCancelDirtyClose
  }
}
