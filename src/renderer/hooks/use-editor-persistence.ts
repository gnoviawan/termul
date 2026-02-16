import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
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
  activeTabId: string | null
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
    const oldProjectId = prevProjectIdRef.current
    prevProjectIdRef.current = projectId

    async function restore(): Promise<void> {
      isRestoringRef.current = true
      try {
        // Persist old project state before clearing
        if (oldProjectId) {
          persistState(oldProjectId)
        }

        // Clear current editor and workspace editor tabs
        useEditorStore.getState().clearAllFiles()
        useWorkspaceStore.getState().clearEditorTabs()

        // Read new project's persisted state
        const result = await window.api.persistence.read<PersistedEditorState>(
          editorStateKey(projectId)
        )

        if (!result.success || !result.data) {
          return
        }

        const persisted = result.data

        // Restore file explorer state
        const explorerStore = useFileExplorerStore.getState()
        explorerStore.setVisible(persisted.fileExplorerVisible)
        if (persisted.expandedDirs.length > 0) {
          explorerStore.setExpandedDirs(new Set(persisted.expandedDirs))
          for (const dir of persisted.expandedDirs) {
            await explorerStore.refreshDirectory(dir)
          }
        }

        // Restore open files
        const editorStore = useEditorStore.getState()
        for (const file of persisted.openFiles) {
          try {
            await editorStore.openFile(file.filePath)
            editorStore.updateCursorPosition(file.filePath, file.cursorPosition.line, file.cursorPosition.col)
            editorStore.updateScrollTop(file.filePath, file.scrollTop)
            if (file.viewMode !== 'code') {
              editorStore.setViewMode(file.filePath, file.viewMode)
            }
            if (file.isDirty && file.draftContent) {
              const currentState = editorStore.openFiles.get(file.filePath)
              if (currentState) {
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

        // Sync workspace editor tabs from restored files
        const openFilePaths = Array.from(useEditorStore.getState().openFiles.keys())
        useWorkspaceStore.getState().syncEditorTabs(openFilePaths, persisted.activeTabId)
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
    let workspaceTimeoutId: ReturnType<typeof setTimeout> | null = null

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

    const unsubWorkspace = useWorkspaceStore.subscribe(() => {
      if (isRestoringRef.current) return

      if (workspaceTimeoutId) clearTimeout(workspaceTimeoutId)
      workspaceTimeoutId = setTimeout(() => {
        persistState(projectId)
      }, 500)
    })

    return () => {
      unsubEditor()
      unsubExplorer()
      unsubWorkspace()
      if (editorTimeoutId) clearTimeout(editorTimeoutId)
      if (explorerTimeoutId) clearTimeout(explorerTimeoutId)
      if (workspaceTimeoutId) clearTimeout(workspaceTimeoutId)
    }
  }, [projectId])
}

function persistState(projectId: string): void {
  const editorState = useEditorStore.getState()
  const explorerState = useFileExplorerStore.getState()
  const workspaceState = useWorkspaceStore.getState()

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
    fileExplorerVisible: explorerState.isVisible,
    activeTabId: workspaceState.activeTabId
  }

  window.api.persistence.writeDebounced(editorStateKey(projectId), data)
}
