import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import {
  useWorkspaceStore,
  findPaneById,
  getAllLeafPanes,
  editorTabId
} from '@/stores/workspace-store'
import type { EditorFileState } from '@/stores/editor-store'
import type { PaneNode, SplitNode, PaneDirection } from '@/types/workspace.types'
import type { WorkspaceTab } from '@/stores/workspace-store'

interface PersistedEditorFile {
  filePath: string
  cursorPosition: { line: number; col: number }
  scrollTop: number
  viewMode: 'code' | 'markdown'
  isDirty: boolean
  draftContent?: string
  lastModified: number
}

// Serialized pane tree for persistence
interface PersistedLeafNode {
  type: 'leaf'
  id: string
  editorFilePaths: string[]
  activeTabId: string | null
}

interface PersistedSplitNode {
  type: 'split'
  id: string
  direction: PaneDirection
  children: PersistedPaneNode[]
  sizes: number[]
}

type PersistedPaneNode = PersistedLeafNode | PersistedSplitNode

interface PersistedEditorState {
  openFiles: PersistedEditorFile[]
  activeFilePath: string | null
  expandedDirs: string[]
  fileExplorerVisible: boolean
  activeTabId: string | null
  // v2: pane layout
  paneLayout?: PersistedPaneNode
  activePaneId?: string
}

function editorStateKey(projectId: string): string {
  return 'editor-state/' + projectId
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function filterExpandedDirsByRoot(expandedDirs: string[], rootPath?: string): string[] {
  if (!rootPath) {
    return []
  }

  const normalizedRoot = normalizePath(rootPath)
  return expandedDirs
    .map((dir) => normalizePath(dir))
    .filter((dir) => dir === normalizedRoot || dir.startsWith(normalizedRoot + '/'))
}

// Serialize pane tree for persistence (strip terminal tabs — they're managed by syncTerminalTabs)
function serializePaneTree(node: PaneNode): PersistedPaneNode {
  if (node.type === 'leaf') {
    const editorFilePaths = node.tabs
      .filter((t): t is WorkspaceTab & { type: 'editor' } => t.type === 'editor')
      .map((t) => t.filePath)
    return {
      type: 'leaf',
      id: node.id,
      editorFilePaths,
      activeTabId: node.activeTabId
    }
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    children: node.children.map(serializePaneTree),
    sizes: node.sizes
  }
}

// Deserialize pane tree — reconstructs editor tabs, terminal tabs added later by syncTerminalTabs
function deserializePaneTree(persisted: PersistedPaneNode): PaneNode {
  if (persisted.type === 'leaf') {
    const tabs: WorkspaceTab[] = persisted.editorFilePaths.map((fp) => ({
      type: 'editor' as const,
      id: editorTabId(fp),
      filePath: fp
    }))
    return {
      type: 'leaf',
      id: persisted.id,
      tabs,
      activeTabId: persisted.activeTabId
    }
  }
  return {
    type: 'split',
    id: persisted.id,
    direction: persisted.direction,
    children: persisted.children.map(deserializePaneTree),
    sizes: persisted.sizes
  }
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

        // Restore file explorer visibility and expanded dirs for this project root
        const explorerStore = useFileExplorerStore.getState()
        explorerStore.setVisible(persisted.fileExplorerVisible)

        const rootPath = useProjectStore
          .getState()
          .projects.find((project) => project.id === projectId)?.path

        const filteredExpandedDirs = filterExpandedDirsByRoot(persisted.expandedDirs, rootPath)
        explorerStore.setExpandedDirs(new Set(filteredExpandedDirs))

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
              const freshEditorState = useEditorStore.getState()
              const currentState = freshEditorState.openFiles.get(file.filePath)
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

        // Restore pane layout if available
        if (persisted.paneLayout) {
          const restoredTree = deserializePaneTree(persisted.paneLayout)

          // Filter out editor tabs for files that failed to open
          const openFilePaths = new Set(useEditorStore.getState().openFiles.keys())
          const filterDeadEditorTabs = (node: PaneNode): PaneNode => {
            if (node.type === 'leaf') {
              const validTabs = node.tabs.filter(
                (t) => t.type !== 'editor' || openFilePaths.has(t.filePath)
              )
              let activeTabId = node.activeTabId
              if (activeTabId && !validTabs.some((t) => t.id === activeTabId)) {
                activeTabId = validTabs.length > 0 ? validTabs[validTabs.length - 1].id : null
              }
              return { ...node, tabs: validTabs, activeTabId }
            }
            return {
              ...node,
              children: node.children.map(filterDeadEditorTabs)
            } as SplitNode
          }

          const cleanTree = filterDeadEditorTabs(restoredTree)
          const activePaneId = persisted.activePaneId || getAllLeafPanes(cleanTree)[0]?.id || cleanTree.id

          useWorkspaceStore.setState({ root: cleanTree, activePaneId })
        } else {
          // Legacy fallback: sync workspace editor tabs from restored files (flat layout)
          const openFilePaths = Array.from(useEditorStore.getState().openFiles.keys())
          useWorkspaceStore.getState().syncEditorTabs(openFilePaths, persisted.activeTabId)
        }

        // Restore expanded directory tree after root initialization.
        await explorerStore.restoreExpandedDirs(filteredExpandedDirs)
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

  const expandedDirs = Array.from(explorerState.expandedDirs)

  const data: PersistedEditorState = {
    openFiles,
    activeFilePath: editorState.activeFilePath,
    expandedDirs,
    fileExplorerVisible: explorerState.isVisible,
    activeTabId: (() => {
      const pane = findPaneById(workspaceState.root, workspaceState.activePaneId)
      return pane && pane.type === 'leaf' ? pane.activeTabId : null
    })(),
    paneLayout: serializePaneTree(workspaceState.root),
    activePaneId: workspaceState.activePaneId
  }

  window.api.persistence.writeDebounced(editorStateKey(projectId), data)
}
