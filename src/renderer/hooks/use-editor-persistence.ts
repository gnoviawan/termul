import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import {
  useWorkspaceStore,
  findPaneById,
  getAllLeafPanes,
  editorTabId,
  terminalTabId
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
interface PersistedEditorTabRef {
  type: 'editor'
  filePath: string
}

interface PersistedTerminalTabRef {
  type: 'terminal'
  terminalId: string
}

type PersistedTabRef = PersistedEditorTabRef | PersistedTerminalTabRef

interface PersistedLeafNode {
  type: 'leaf'
  id: string
  tabs: PersistedTabRef[]
  activeTabId: string | null
}

interface PersistedSplitNode {
  type: 'split'
  id: string
  direction: PaneDirection
  children: PersistedPaneNode[]
  sizes: number[]
}

interface LegacyPersistedLeafNode {
  type: 'leaf'
  id: string
  editorFilePaths: string[]
  activeTabId: string | null
}

type PersistedPaneNode = PersistedLeafNode | PersistedSplitNode

type PersistedPaneNodeInput = PersistedPaneNode | LegacyPersistedLeafNode

interface PersistedEditorState {
  openFiles: PersistedEditorFile[]
  activeFilePath: string | null
  expandedDirs: string[]
  fileExplorerVisible: boolean
  activeTabId: string | null
  // v2: pane layout
  paneLayout?: PersistedPaneNodeInput
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

// Serialize pane tree for persistence with both editor and terminal tabs
function serializePaneTree(node: PaneNode): PersistedPaneNode {
  if (node.type === 'leaf') {
    const tabs: PersistedTabRef[] = node.tabs.flatMap((tab): PersistedTabRef[] => {
      if (tab.type === 'editor') {
        return [{ type: 'editor', filePath: tab.filePath }]
      }

      if (tab.type === 'terminal') {
        return [{ type: 'terminal', terminalId: tab.terminalId }]
      }

      return []
    })

    return {
      type: 'leaf',
      id: node.id,
      tabs,
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

function sanitizePaneNode(node: PaneNode): PaneNode | null {
  if (node.type === 'leaf') {
    return node
  }

  // Track original indices to correctly map sizes after filtering
  const survivingEntries = node.children
    .map((child, originalIndex) => ({
      child: sanitizePaneNode(child),
      originalIndex
    }))
    .filter((entry): entry is { child: PaneNode; originalIndex: number } => entry.child !== null)

  if (survivingEntries.length === 0) {
    return null
  }

  if (survivingEntries.length === 1) {
    return survivingEntries[0].child
  }

  const rawSizes = node.sizes
  const validSizes = survivingEntries.map((entry) => {
    const value = rawSizes[entry.originalIndex]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
  })
  const total = validSizes.reduce((sum, value) => sum + value, 0)

  return {
    ...node,
    children: survivingEntries.map((entry) => entry.child),
    sizes: validSizes.map((value) => (value / total) * 100)
  }
}

function normalizePaneTree(root: PaneNode): PaneNode {
  const normalized = sanitizePaneNode(root)
  if (normalized) {
    return normalized
  }

  return {
    type: 'leaf',
    id: crypto.randomUUID(),
    tabs: [],
    activeTabId: null
  }
}

// Deserialize pane tree with full tab mapping
function deserializePaneTree(persisted: PersistedPaneNodeInput): PaneNode {
  if (persisted.type === 'leaf') {
    const tabs: WorkspaceTab[] = ('tabs' in persisted ? persisted.tabs : []).flatMap(
      (tab): WorkspaceTab[] => {
        if (tab.type === 'editor') {
          return [
            {
              type: 'editor',
              id: editorTabId(tab.filePath),
              filePath: tab.filePath
            }
          ]
        }

        return [
          {
            type: 'terminal',
            id: terminalTabId(tab.terminalId),
            terminalId: tab.terminalId
          }
        ]
      }
    )

    // Backward-compatibility fallback for legacy pre-release shape.
    if (tabs.length === 0 && 'editorFilePaths' in persisted) {
      persisted.editorFilePaths.forEach((filePath) => {
        tabs.push({
          type: 'editor',
          id: editorTabId(filePath),
          filePath
        })
      })
    }

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

        // Clear editor files (in-memory state), but defer workspace pane reset
        // until we know the destination layout to avoid a flash of empty pane.
        useEditorStore.getState().clearAllFiles()

        // Read new project's persisted state
        const result = await window.api.persistence.read<PersistedEditorState>(
          editorStateKey(projectId)
        )

        if (!result.success || !result.data) {
          // No persisted state — reset to single empty pane
          useWorkspaceStore.getState().resetLayout()
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

        // Restore pane layout — single atomic setState replaces the old tree
        if (persisted.paneLayout) {
          const restoredTree = deserializePaneTree(persisted.paneLayout)
          const openFilePaths = new Set(useEditorStore.getState().openFiles.keys())
          const filterUnavailableTabs = (node: PaneNode): PaneNode => {
            if (node.type === 'leaf') {
              const validTabs = node.tabs.filter((tab) => {
                if (tab.type === 'editor') {
                  return openFilePaths.has(tab.filePath)
                }

                return true
              })

              let activeTabId = node.activeTabId
              if (activeTabId && !validTabs.some((tab) => tab.id === activeTabId)) {
                activeTabId = validTabs.length > 0 ? validTabs[0].id : null
              }

              return {
                ...node,
                tabs: validTabs,
                activeTabId
              }
            }

            return {
              ...node,
              children: node.children.map(filterUnavailableTabs)
            } as SplitNode
          }

          const cleanTree = normalizePaneTree(filterUnavailableTabs(restoredTree))
          const leaves = getAllLeafPanes(cleanTree)
          const persistedActivePaneId = persisted.activePaneId
          const resolvedActivePaneId =
            persistedActivePaneId && leaves.some((leaf) => leaf.id === persistedActivePaneId)
              ? persistedActivePaneId
              : leaves[0]?.id ?? cleanTree.id

          useWorkspaceStore.setState({ root: cleanTree, activePaneId: resolvedActivePaneId })
        } else {
          // Legacy fallback: build a fresh layout with editor tabs
          useWorkspaceStore.getState().resetLayout()
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

export function persistState(projectId: string): void {
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
