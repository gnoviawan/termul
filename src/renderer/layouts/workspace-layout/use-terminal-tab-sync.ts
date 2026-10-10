import { useEffect, useRef } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  getActiveFilePathFromTree,
  getActiveTerminalIdFromTree,
  useWorkspaceStore
} from '@/stores/workspace-store'
import type { Terminal } from '@/types/project'

interface UseTerminalTabSyncOptions {
  terminals: Terminal[]
  activeProjectId: string
}

/** Keeps workspace tabs and the legacy terminal/editor stores in sync with the pane tree. */
export function useTerminalTabSync({
  terminals,
  activeProjectId
}: UseTerminalTabSyncOptions): void {
  // Ensure tabs exist for currently visible project terminals.
  // Project workspace loading/removal is owned by persistence + restore flows.
  // Debounce: rapid terminal store mutations (addTerminal → setTerminalPtyId →
  // addTabToPane) settle before syncTerminalTabs runs, preventing the MOUNT/UNMOUNT
  // cascade where intermediate states look like "orphaned" tabs.
  const ensureCallCountRef = useRef(0)
  const lastEnsuredTerminalIdsRef = useRef<string[]>([])
  const lastEnsuredProjectIdRef = useRef<string>('')
  const syncDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const terminalIds = terminals.map((terminal) => terminal.id)

    // Clear any pending debounce — only the latest mutation triggers a sync.
    if (syncDebounceTimerRef.current) {
      clearTimeout(syncDebounceTimerRef.current)
      syncDebounceTimerRef.current = null
    }

    // If we switched projects, we should wait for the persistence layer (useEditorPersistence)
    // to finish its job of replacing the entire workspace tree.
    // Forcing a sync on the WRONG tree (the old project's tree) causes "leaking" tabs.
    if (activeProjectId !== lastEnsuredProjectIdRef.current) {
      lastEnsuredTerminalIdsRef.current = terminalIds
      lastEnsuredProjectIdRef.current = activeProjectId
      // We skip the sync here because useEditorPersistence will handle the initial layout.
      return
    }

    const prevIds = lastEnsuredTerminalIdsRef.current
    if (terminalIds.length === prevIds.length && terminalIds.every((id, i) => id === prevIds[i])) {
      return
    }

    // Debounce: wait for store mutations to settle before syncing tabs.
    // This prevents the cascade where syncTerminalTabs runs between addTerminal
    // and addTabToPane, sees a tab as orphaned, removes it, triggering
    // ConnectedTerminal unmount and a restore re-trigger.
    syncDebounceTimerRef.current = setTimeout(() => {
      lastEnsuredTerminalIdsRef.current = terminalIds
      const ensureId = `ensure-${ensureCallCountRef.current++}-${Date.now().toString().slice(-6)}`

      console.log(`[WorkspaceLayout] syncTerminalTabs CALL [${ensureId}]`, {
        projectId: activeProjectId,
        terminalCount: terminalIds.length,
        terminalIds,
        prevCount: prevIds.length,
        callCount: ensureCallCountRef.current
      })

      const workspaceStore = useWorkspaceStore.getState()
      workspaceStore.syncTerminalTabs(terminalIds)
    }, 100)

    return () => {
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current)
        syncDebounceTimerRef.current = null
      }
    }
  }, [terminals, activeProjectId])

  // Sync legacy stores (activeTerminalId, activeFilePath) from workspace pane tree
  useEffect(() => {
    return useWorkspaceStore.subscribe((state, prevState) => {
      if (state.root === prevState.root && state.activePaneId === prevState.activePaneId) return

      const terminalId = getActiveTerminalIdFromTree(state)
      if (terminalId !== null) {
        const termStore = useTerminalStore.getState()
        if (termStore.activeTerminalId !== terminalId) {
          termStore.selectTerminal(terminalId)
        }
      }

      const filePath = getActiveFilePathFromTree(state)
      const editorStore = useEditorStore.getState()
      if (editorStore.activeFilePath !== filePath) {
        editorStore.setActiveFilePath(filePath)
      }
    })
  }, [])
}
