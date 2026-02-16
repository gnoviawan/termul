import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import type { EditorFileState } from '@/stores/editor-store'

interface PersistedEditorFile {
  filePath: string
  cursorPosition: { line: number; col: number }
  scrollTop: number
  viewMode: 'code' | 'markdown'
  isDirty: boolean
  draftContent?: string
  lastModified: number
}

interface PersistedEditorState {
  openFiles: PersistedEditorFile[]
  activeFilePath: string | null
  expandedDirs: string[]
  fileExplorerVisible: boolean
}

function editorStateKey(projectId: string): string {
  return 'editor-state/' + projectId
}

export function useEditorPersistence(projectId: string): void {
  const isRestoringRef = useRef(false)
  const prevProjectIdRef = useRef('')

  // Restore state when project changes
  useEffect(() => {
    if (!projectId || projectId === prevProjectIdRef.current) return
    prevProjectIdRef.current = projectId

    async function restore(): Promise<void> {
      isRestoringRef.current = true
      try {
        const result = await window.api.persistence.read<PersistedEditorState>(
          editorStateKey(projectId)
        )

        if (!result.success || !result.data) {
          isRestoringRef.current = false
          return
        }

        const persisted = result.data

        // Restore file explorer state
        const explorerStore = useFileExplorerStore.getState()
        explorerStore.setVisible(persisted.fileExplorerVisible)
        if (persisted.expandedDirs.length > 0) {
          explorerStore.setExpandedDirs(new Set(persisted.expandedDirs))
          // Load contents for expanded dirs
          for (const dir of persisted.expandedDirs) {
            await explorerStore.refreshDirectory(dir)
          }
        }

        // Restore open files
        const editorStore = useEditorStore.getState()
        for (const file of persisted.openFiles) {
          try {
            await editorStore.openFile(file.filePath)

            // Apply cursor, scroll, viewMode
            editorStore.updateCursorPosition(file.filePath, file.cursorPosition.line, file.cursorPosition.col)
            editorStore.updateScrollTop(file.filePath, file.scrollTop)
            if (file.viewMode !== 'code') {
              editorStore.setViewMode(file.filePath, file.viewMode)
            }

            // Restore draft content for dirty files
            if (file.isDirty && file.draftContent) {
              const currentState = editorStore.openFiles.get(file.filePath)
              if (currentState) {
                // Only restore draft if file hasn't changed on disk
                if (currentState.lastModified <= file.lastModified) {
                  editorStore.updateContent(file.filePath, file.draftContent)
                }
              }
            }
          } catch {
            // File may have been deleted since last session
          }
        }

        // Restore active file
        if (persisted.activeFilePath) {
          editorStore.setActiveFilePath(persisted.activeFilePath)
        }
      } finally {
        isRestoringRef.current = false
      }
    }

    restore()
  }, [projectId])

  // Save state on changes (debounced)
  useEffect(() => {
    if (!projectId) return

    let editorTimeoutId: ReturnType<typeof setTimeout> | null = null
    let explorerTimeoutId: ReturnType<typeof setTimeout> | null = null

    const unsubEditor = useEditorStore.subscribe(() => {
      if (isRestoringRef.current) return

      if (editorTimeoutId) clearTimeout(editorTimeoutId)
      editorTimeoutId = setTimeout(() => {
        persistState(projectId)
      }, 500)
    })

    const unsubExplorer = useFileExplorerStore.subscribe(() => {
      if (isRestoringRef.current) return

      if (explorerTimeoutId) clearTimeout(explorerTimeoutId)
      explorerTimeoutId = setTimeout(() => {
        persistState(projectId)
      }, 500)
    })

    return () => {
      unsubEditor()
      unsubExplorer()
      if (editorTimeoutId) clearTimeout(editorTimeoutId)
      if (explorerTimeoutId) clearTimeout(explorerTimeoutId)
    }
  }, [projectId])
}

function persistState(projectId: string): void {
  const editorState = useEditorStore.getState()
  const explorerState = useFileExplorerStore.getState()

  const openFiles: PersistedEditorFile[] = []
  editorState.openFiles.forEach((file: EditorFileState) => {
    const persisted: PersistedEditorFile = {
      filePath: file.filePath,
      cursorPosition: file.cursorPosition,
      scrollTop: file.scrollTop,
      viewMode: file.viewMode,
      isDirty: file.isDirty,
      lastModified: file.lastModified
    }
    if (file.isDirty) {
      persisted.draftContent = file.content
    }
    openFiles.push(persisted)
  })

  const expandedDirs: string[] = []
  explorerState.expandedDirs.forEach((dir) => expandedDirs.push(dir))

  const data: PersistedEditorState = {
    openFiles,
    activeFilePath: editorState.activeFilePath,
    expandedDirs,
    fileExplorerVisible: explorerState.isVisible
  }

  window.api.persistence.writeDebounced(editorStateKey(projectId), data)
}
