import { useEffect } from 'react'
import { toast } from 'sonner'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useEditorStore } from '@/stores/editor-store'
import { useWorkspaceStore, editorTabId } from '@/stores/workspace-store'
import type { FileChangeEvent } from '@shared/types/filesystem.types'

function getDirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) return normalized
  return normalized.slice(0, lastSlash)
}

export function useFileWatcher(): void {
  useEffect(() => {
    const pendingRefreshDirs = new Set<string>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleRefresh(dir: string): void {
      const explorerState = useFileExplorerStore.getState()
      if (!explorerState.expandedDirs.has(dir)) return

      pendingRefreshDirs.add(dir)

      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = setTimeout(() => {
        const explorerState = useFileExplorerStore.getState()
        for (const dirPath of pendingRefreshDirs) {
          if (explorerState.expandedDirs.has(dirPath)) {
            explorerState.refreshDirectory(dirPath)
          }
        }
        pendingRefreshDirs.clear()
        flushTimer = null
      }, 300)
    }

    const handleFileChanged = (event: FileChangeEvent): void => {
      const { path } = event

      // Debounced refresh for file explorer
      const parentDir = getDirname(path)
      scheduleRefresh(parentDir)

      // Handle open editor files (immediate — not debounced)
      const editorState = useEditorStore.getState()
      const fileState = editorState.openFiles.get(path)
      if (fileState) {
        // Skip if we just saved this file (within 2 seconds)
        if (Date.now() - fileState.lastModified < 2000) {
          return
        }

        if (!fileState.isDirty) {
          editorState.reloadFile(path)
        } else {
          toast('File changed externally', {
            description: path.split(/[\\/]/).pop() || path,
            action: {
              label: 'Reload',
              onClick: () => {
                useEditorStore.getState().reloadFile(path)
              }
            }
          })
        }
      }
    }

    const handleFileCreated = (event: FileChangeEvent): void => {
      const parentDir = getDirname(event.path)
      scheduleRefresh(parentDir)
    }

    const handleFileDeleted = (event: FileChangeEvent): void => {
      const parentDir = getDirname(event.path)
      scheduleRefresh(parentDir)

      // Close editor tab immediately if the deleted file is open
      const editorState = useEditorStore.getState()
      if (editorState.openFiles.has(event.path)) {
        editorState.closeFile(event.path)
        useWorkspaceStore.getState().removeTab(editorTabId(event.path))
      }
    }

    const unsubChanged = window.api.filesystem.onFileChanged(handleFileChanged)
    const unsubCreated = window.api.filesystem.onFileCreated(handleFileCreated)
    const unsubDeleted = window.api.filesystem.onFileDeleted(handleFileDeleted)

    return () => {
      if (flushTimer) clearTimeout(flushTimer)
      pendingRefreshDirs.clear()
      unsubChanged()
      unsubCreated()
      unsubDeleted()
    }
  }, [])
}
