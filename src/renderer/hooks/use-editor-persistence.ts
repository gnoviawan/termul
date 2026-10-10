import { useEffect, useRef } from 'react'
import { persistenceApi } from '@/lib/api'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import type { EditorFileState } from '@/stores/editor-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { setManifestRestoreInProgress } from '@/stores/workspace-manifest-sync-store'
import { findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import { reattachOpenAgentChats, retainVisibleAgentChats } from './editor-persistence/chat-restore'
import {
  chatForeignToProject,
  deserializePaneTree,
  reconcileTerminalTabs,
  serializePaneTree
} from './editor-persistence/pane-tree'
import {
  editorStateKey,
  filterExpandedDirsByRoot,
  type PersistedEditorFile,
  type PersistedEditorState
} from './editor-persistence/types'
import { loadWorkspaceManifest } from './use-workspace-manifest-sync'
import { loadPersistedTerminals } from './useTerminalAutoSave'

export { deserializePaneTree, reconcileTerminalTabs } from './editor-persistence/pane-tree'

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
      return (
        cancelled ||
        restoreRunIdRef.current !== restoreRunId ||
        prevProjectIdRef.current !== projectId
      )
    }

    if (oldProjectId) retainVisibleAgentChats(oldProjectId)

    async function restore(): Promise<void> {
      isRestoringRef.current = true
      // Guard the manifest writer for the entire restore window so a half-built
      // tree (mid open-files loop, mid pane rebuild) is never persisted as the
      // new host manifest. The terminal-restore guard already covers PTY
      // reattachment; this mirrors it for the manifest's portable projection.
      setManifestRestoreInProgress(projectId, true)
      try {
        // Persist old project state before clearing
        if (oldProjectId) {
          persistState(oldProjectId)
        }

        // Clear editor files (in-memory state) and swap the pane tree to the
        // fresh launcher optimistically (see the resetLayout comment below).
        useEditorStore.getState().clearAllFiles()
        // Optimistic layout swap (web project-switch lag): reset the pane
        // tree to the fresh launcher NOW, before the async reads below
        // (persistence WS read + manifest GET + open-file loop) — the old
        // comment's "defer … to avoid a flash of empty pane" instead left
        // the PREVIOUS project's tree (with its still-streaming chat)
        // mounted for the whole restore window: the sidebar badge flips
        // but the workspace looks frozen ("didn't change"), and every
        // streaming chunk re-render competes with the restore commits
        // (measured: up to ~2-5s to visible swap under load). The fresh
        // layout renders instantly, the destination layout replaces it
        // when the reads land, and the old project's chat panels unmount
        // (their hidden-store selectors stop re-rendering on chunks).
        // Only on a real SWITCH: a first mount already starts from the
        // fresh layout (an unconditional reset would also clobber a
        // boot-time layout restored by the chat-route bootstrap).
        if (oldProjectId) {
          useWorkspaceStore.getState().resetLayout()
          // The launcher overlay's pane was just removed by the reset; clear
          // its tracked pane id too, or WorkspaceLayout keeps treating a
          // launcher as open (suppressing shortcuts like Ctrl/Cmd+W) until
          // the launcher is toggled again.
          useWorkspaceStore.getState().hideAgentLauncher()
        }

        // Read new project's persisted state
        const result = await persistenceApi.read<PersistedEditorState>(editorStateKey(projectId))

        if (isStale()) {
          return
        }

        if (!result.success || !result.data) {
          // No persisted renderer-local editor state. A host manifest may still
          // exist (cross-client: this client never opened the project before).
          // Consult the manifest; if absent, start fresh.
          const manifestRestored = await loadWorkspaceManifest(projectId)
          if (isStale()) {
            return
          }
          if (!manifestRestored) {
            useWorkspaceStore.getState().resetLayout()
          }
          reattachOpenAgentChats(projectId, undefined)
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

            editorStore.updateCursorPosition(
              file.filePath,
              file.cursorPosition.line,
              file.cursorPosition.col
            )
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

        // Restore pane layout. The manifest is authoritative for portable
        // topology (terminalIds + editorIds + activeTabId + activePaneId). If a
        // manifest exists it wins; else fall back to editorStateKey.paneLayout
        // (legacy path carrying all tab variants incl. browser/git/agent-chat).
        // The manifest load runs AFTER the open-files loop above so renderer-
        // local editor state (drafts/scroll/cursor) is reconciled with the
        // manifest topology. Non-portable tab variants are absent on manifest
        // restore (CAP-5 contract decision) — they survive only in the legacy
        // editorStateKey.paneLayout path. The manifestRestoreInProgress guard
        // set at the top of restore() covers this load + tree build.
        const manifestRestored = await loadWorkspaceManifest(projectId)
        if (isStale()) {
          return
        }

        if (!manifestRestored) {
          // No manifest (or load failed — logged + degraded gracefully).
          // Fall back to the existing renderer-local paneLayout path.
          if (persisted.paneLayout) {
            const openFilePaths = new Set(useEditorStore.getState().openFiles.keys())
            const liveProjectTerminals = useTerminalStore
              .getState()
              .terminals.filter((terminal) => terminal.projectId === projectId && !!terminal.ptyId)
            const persistedTerminalLayout = await loadPersistedTerminals(projectId)
            if (isStale()) {
              return
            }

            // Deserialize AFTER the await, right before the commit: the
            // session index may land during it, and its prune only scans the
            // committed tree — judging ownership earlier would let a now-
            // known foreign chat slip in. Unknown ownership stays fail-open.
            const restoredTree = deserializePaneTree(persisted.paneLayout, projectId)
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
        }

        reattachOpenAgentChats(projectId, persisted.paneLayout)

        // Restore expanded directory tree after root initialization.
        await explorerStore.restoreExpandedDirs(filteredExpandedDirs)
        if (isStale()) {
          return
        }
      } finally {
        if (restoreRunIdRef.current === restoreRunId) {
          isRestoringRef.current = false
          setManifestRestoreInProgress(projectId, false)
        } else if (prevProjectIdRef.current !== projectId) {
          // Superseded by a run for a DIFFERENT project: that run owns its own
          // guard key, so this project's key would otherwise stay `true`
          // forever (blocking manifest writes for it until the user returns).
          // The same-project supersession is still owned by the newer run
          // (handled by the branch above when it completes).
          setManifestRestoreInProgress(projectId, false)
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
    const unsubBrowserSessions = useBrowserSessionStore.subscribe((state, prevState) => {
      if (state.tabs !== prevState.tabs) {
        schedulePersist()
      }
    })

    return () => {
      unsubEditor()
      unsubExplorer()
      unsubWorkspace()
      unsubBrowserSessions()
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
    // Project ownership filter (see retainVisibleAgentChats): the pane tree
    // is global, so agent-chat tabs of OTHER projects can be present when
    // this project's state is saved. Persisting them seeds cross-project
    // tab leaks on restore (the layout re-adds foreign chats into this
    // project's workspace — accumulating mixed tabs across switches).
    paneLayout: serializePaneTree(workspaceState.root, {
      // Keep when NOT known-foreign (fail-open — see chatForeignToProject).
      agentChatOwnedBy: (sessionId) => !chatForeignToProject(sessionId, projectId)
    }),
    activePaneId: workspaceState.activePaneId
  }

  persistenceApi.writeDebounced(editorStateKey(projectId), data)
}
