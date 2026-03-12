import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { persistenceApi } from '@/lib/api'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  useWorkspaceStore,
  findPaneById,
  getAllLeafPanes,
  editorTabId,
  terminalTabId
} from '@/stores/workspace-store'
import { loadPersistedTerminals } from './useTerminalAutoSave'
import type { EditorFileState } from '@/stores/editor-store'
import type { PaneNode, SplitNode, PaneDirection } from '@/types/workspace.types'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'
import type { PersistedTerminalLayout } from '../../shared/types/persistence.types'

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

function createTerminalMatcher(
  liveTerminals: Terminal[],
  layout: PersistedTerminalLayout | null
): {
  hasLiveTerminals: boolean
  matchTerminalId: (persistedTerminalId: string) => string | null
} {
  const liveTerminalsById = new Map(liveTerminals.map((terminal) => [terminal.id, terminal]))
  const layoutTerminalsById = new Map(layout?.terminals.map((terminal) => [terminal.id, terminal]) ?? [])
  const unusedLiveTerminals = [...liveTerminals]

  const consumeLiveTerminal = (terminalId: string): string | null => {
    const match = liveTerminalsById.get(terminalId)
    if (!match) {
      return null
    }

    const index = unusedLiveTerminals.findIndex((terminal) => terminal.id === terminalId)
    if (index >= 0) {
      unusedLiveTerminals.splice(index, 1)
    }
    return match.id
  }

  return {
    hasLiveTerminals: liveTerminals.length > 0,
    matchTerminalId: (persistedTerminalId: string): string | null => {
      const directMatch = consumeLiveTerminal(persistedTerminalId)
      if (directMatch) {
        return directMatch
      }

      const persistedTerminal = layoutTerminalsById.get(persistedTerminalId)
      if (!persistedTerminal) {
        return null
      }

      const exactIndex = unusedLiveTerminals.findIndex((terminal) => {
        return (
          terminal.name === persistedTerminal.name &&
          terminal.shell === persistedTerminal.shell &&
          terminal.cwd === persistedTerminal.cwd
        )
      })
      if (exactIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(exactIndex, 1)
        return match.id
      }

      const nameAndShellIndex = unusedLiveTerminals.findIndex((terminal) => {
        return terminal.name === persistedTerminal.name && terminal.shell === persistedTerminal.shell
      })
      if (nameAndShellIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(nameAndShellIndex, 1)
        return match.id
      }

      const nameOnlyIndex = unusedLiveTerminals.findIndex(
        (terminal) => terminal.name === persistedTerminal.name
      )
      if (nameOnlyIndex >= 0) {
        const [match] = unusedLiveTerminals.splice(nameOnlyIndex, 1)
        return match.id
      }

      return null
    }
  }
}

function reconcileTerminalTabs(
  root: PaneNode,
  openFilePaths: Set<string>,
  liveTerminals: Terminal[],
  layout: PersistedTerminalLayout | null
): PaneNode {
  const { hasLiveTerminals, matchTerminalId } = createTerminalMatcher(liveTerminals, layout)
  const shouldKeepPersistedTerminalTabs = !hasLiveTerminals && !!layout?.terminals.length

  const visit = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') {
      const terminalTabIdMap = new Map<string, string>()
      const validTabs = node.tabs.flatMap((tab): WorkspaceTab[] => {
        if (tab.type === 'editor') {
          return openFilePaths.has(tab.filePath) ? [tab] : []
        }

        if (shouldKeepPersistedTerminalTabs) {
          return [tab]
        }

        const mappedTerminalId = matchTerminalId(tab.terminalId)
        if (!mappedTerminalId) {
          return []
        }

        const mappedTabId = terminalTabId(mappedTerminalId)
        terminalTabIdMap.set(tab.id, mappedTabId)

        return [
          {
            type: 'terminal',
            id: mappedTabId,
            terminalId: mappedTerminalId
          }
        ]
      })

      let activeTabId = node.activeTabId
      if (activeTabId && terminalTabIdMap.has(activeTabId)) {
        activeTabId = terminalTabIdMap.get(activeTabId) ?? activeTabId
      }
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
      children: node.children.map(visit)
    } as SplitNode
  }

  return normalizePaneTree(visit(root))
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
  const restoreRunIdRef = useRef(0)

  // Restore state when project changes
  useEffect(() => {
    if (!projectId || projectId === prevProjectIdRef.current) return
    const oldProjectId = prevProjectIdRef.current
    prevProjectIdRef.current = projectId

    const restoreRunId = ++restoreRunIdRef.current
    let cancelled = false
    const isStale = (): boolean => {
      return cancelled || restoreRunIdRef.current !== restoreRunId || prevProjectIdRef.current !== projectId
    }

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
        const result = await persistenceApi.read<PersistedEditorState>(
          editorStateKey(projectId)
        )

        if (isStale()) {
          return
        }

        if (!result.success || !result.data) {
          // No persisted state — reset to single empty pane
          useWorkspaceStore.getState().resetLayout()
          return
        }

        const persisted = result.data

        // Restore expanded dirs for this project root
        const explorerStore = useFileExplorerStore.getState()

        const rootPath = useProjectStore
          .getState()
          .projects.find((project) => project.id === projectId)?.path

        const filteredExpandedDirs = filterExpandedDirsByRoot(persisted.expandedDirs, rootPath)
        explorerStore.setExpandedDirs(new Set(filteredExpandedDirs))

        // Restore open files
        const editorStore = useEditorStore.getState()
        for (const file of persisted.openFiles) {
          if (isStale()) {
            return
          }

          try {
            await editorStore.openFile(file.filePath)
            if (isStale()) {
              return
            }

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

        if (isStale()) {
          return
        }

        // Restore active file
        if (persisted.activeFilePath) {
          editorStore.setActiveFilePath(persisted.activeFilePath)
        }

        // Restore pane layout — single atomic setState replaces the old tree
        if (persisted.paneLayout) {
          const restoredTree = deserializePaneTree(persisted.paneLayout)
          const openFilePaths = new Set(useEditorStore.getState().openFiles.keys())
          const liveProjectTerminals = useTerminalStore
            .getState()
            .terminals.filter((terminal) => terminal.projectId === projectId && !!terminal.ptyId)
          const persistedTerminalLayout = await loadPersistedTerminals(projectId)
          if (isStale()) {
            return
          }

          const cleanTree = reconcileTerminalTabs(
            restoredTree,
            openFilePaths,
            liveProjectTerminals,
            persistedTerminalLayout
          )
          useWorkspaceStore.getState().loadProjectWorkspace(cleanTree, persisted.activePaneId)
        } else {
          // Legacy fallback: build a fresh layout with editor tabs
          useWorkspaceStore.getState().resetLayout()
          const openFilePaths = Array.from(useEditorStore.getState().openFiles.keys())
          useWorkspaceStore.getState().syncEditorTabs(openFilePaths, persisted.activeTabId)
        }

        // Restore expanded directory tree after root initialization.
        await explorerStore.restoreExpandedDirs(filteredExpandedDirs)
        if (isStale()) {
          return
        }
      } finally {
        if (restoreRunIdRef.current === restoreRunId) {
          isRestoringRef.current = false
        }
      }
    }

    void restore()

    return () => {
      cancelled = true
    }
  }, [projectId])

  // Save state on changes (debounced) - coalesced across all store subscriptions
  useEffect(() => {
    if (!projectId) return

    let persistTimeoutId: ReturnType<typeof setTimeout> | null = null

    const schedulePersist = (): void => {
      if (isRestoringRef.current) return
      if (persistTimeoutId) clearTimeout(persistTimeoutId)
      persistTimeoutId = setTimeout(() => {
        persistState(projectId)
      }, 500)
    }

    const unsubEditor = useEditorStore.subscribe(schedulePersist)
    const unsubExplorer = useFileExplorerStore.subscribe((state, prevState) => {
      if (state.expandedDirs !== prevState.expandedDirs) {
        schedulePersist()
      }
    })
    const unsubWorkspace = useWorkspaceStore.subscribe(schedulePersist)

    return () => {
      unsubEditor()
      unsubExplorer()
      unsubWorkspace()
      if (persistTimeoutId) clearTimeout(persistTimeoutId)
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
    activeTabId: (() => {
      const pane = findPaneById(workspaceState.root, workspaceState.activePaneId)
      return pane && pane.type === 'leaf' ? pane.activeTabId : null
    })(),
    paneLayout: serializePaneTree(workspaceState.root),
    activePaneId: workspaceState.activePaneId
  }

  persistenceApi.writeDebounced(editorStateKey(projectId), data)
}
