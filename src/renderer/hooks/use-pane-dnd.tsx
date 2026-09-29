import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '@/stores/editor-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { editorTabId, findPaneById, useWorkspaceStore } from '@/stores/workspace-store'
import type { DragPayload, DropPosition, TabReorderPosition } from '@/types/workspace.types'

interface DropPreviewTarget {
  paneId: string
  position: DropPosition
}

export interface ReorderPreview {
  paneId: string
  targetTabId: string
  position: TabReorderPosition
}

/**
 * Signal recorded when a drop commits. Split-layout tweens key off this to
 * distinguish drop-created panel changes from unrelated remounts (fullscreen
 * toggle, project restore) — see use-pane-split-animation.ts.
 */
export interface PaneDropInfo {
  targetPaneId: string
  position: DropPosition
  at: number
}

interface PaneDndContextValue {
  isDragging: boolean
  dragPayload: DragPayload | null
  previewTarget: DropPreviewTarget | null
  lastDrop: PaneDropInfo | null
  setPreviewTarget: (paneId: string, position: DropPosition) => void
  clearPreviewTarget: (paneId?: string, position?: DropPosition) => void
  reorderPreview: ReorderPreview | null
  setReorderPreview: (paneId: string, targetTabId: string, position: TabReorderPosition) => void
  clearReorderPreview: () => void
  startTabDrag: (tabId: string, paneId: string, event: React.DragEvent) => void
  startFileDrag: (filePath: string, event: React.DragEvent) => void
  handleDrop: (targetPaneId: string, position: DropPosition, event: React.DragEvent) => void
  handleTabReorder: (
    sourcePaneId: string,
    targetTabId: string,
    position: TabReorderPosition
  ) => void
}

const PaneDndContext = createContext<PaneDndContextValue | null>(null)

const noop = (): void => {}
const noopPane = (): void => {}

const fallbackContext: PaneDndContextValue = {
  isDragging: false,
  dragPayload: null,
  previewTarget: null,
  lastDrop: null,
  setPreviewTarget: noop,
  clearPreviewTarget: noopPane,
  reorderPreview: null,
  setReorderPreview: noop,
  clearReorderPreview: noop,
  startTabDrag: noop,
  startFileDrag: noop,
  handleDrop: noop,
  handleTabReorder: noop
}

export function usePaneDnd(): PaneDndContextValue {
  const ctx = useContext(PaneDndContext)
  return ctx ?? fallbackContext
}

interface PaneDndProviderProps {
  children: React.ReactNode
}

function parseDragPayload(raw: string): DragPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const payload = parsed as Record<string, unknown>

    if (payload.type === 'tab') {
      if (typeof payload.tabId !== 'string' || typeof payload.sourcePaneId !== 'string') {
        return null
      }
      return {
        type: 'tab',
        tabId: payload.tabId,
        sourcePaneId: payload.sourcePaneId
      }
    }

    if (payload.type === 'file') {
      if (typeof payload.filePath !== 'string') {
        return null
      }
      return {
        type: 'file',
        filePath: payload.filePath
      }
    }

    return null
  } catch {
    return null
  }
}

export function PaneDndProvider({ children }: PaneDndProviderProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null)
  const [previewTarget, setPreviewTargetState] = useState<DropPreviewTarget | null>(null)
  const [reorderPreview, setReorderPreviewState] = useState<ReorderPreview | null>(null)
  const [lastDrop, setLastDropState] = useState<PaneDropInfo | null>(null)

  const clearPreviewTarget = useCallback((paneId?: string, position?: DropPosition) => {
    setPreviewTargetState((current) => {
      if (!current) return null
      if (paneId && current.paneId !== paneId) return current
      if (position && current.position !== position) return current
      return null
    })
  }, [])

  const setPreviewTarget = useCallback((paneId: string, position: DropPosition) => {
    setPreviewTargetState((current) => {
      if (current?.paneId === paneId && current.position === position) {
        return current
      }
      return { paneId, position }
    })
  }, [])

  const setReorderPreview = useCallback(
    (paneId: string, targetTabId: string, position: TabReorderPosition) => {
      setReorderPreviewState((current) => {
        if (
          current?.paneId === paneId &&
          current.targetTabId === targetTabId &&
          current.position === position
        ) {
          return current
        }
        return { paneId, targetTabId, position }
      })
    },
    []
  )

  const clearReorderPreview = useCallback(() => {
    setReorderPreviewState(null)
  }, [])

  // Track drag state via document-level events
  useEffect(() => {
    const handleDragEnd = (): void => {
      setIsDragging(false)
      setDragPayload(null)
      clearPreviewTarget()
      clearReorderPreview()
    }

    document.addEventListener('dragend', handleDragEnd)
    return () => {
      document.removeEventListener('dragend', handleDragEnd)
    }
  }, [clearPreviewTarget, clearReorderPreview])

  const startTabDrag = useCallback(
    (tabId: string, paneId: string, event: React.DragEvent) => {
      const payload: DragPayload = {
        type: 'tab',
        tabId,
        sourcePaneId: paneId
      }
      event.dataTransfer.setData('application/json', JSON.stringify(payload))
      event.dataTransfer.effectAllowed = 'move'
      setDragPayload(payload)
      setIsDragging(true)
      clearPreviewTarget()
      // A new drag voids the previous drop signal so a stale `lastDrop` can
      // never gate an unrelated pane-tree change.
      setLastDropState(null)
    },
    [clearPreviewTarget]
  )

  const startFileDrag = useCallback(
    (filePath: string, event: React.DragEvent) => {
      const payload: DragPayload = {
        type: 'file',
        filePath
      }
      event.dataTransfer.setData('application/json', JSON.stringify(payload))
      event.dataTransfer.effectAllowed = 'move'
      setDragPayload(payload)
      setIsDragging(true)
      clearPreviewTarget()
      setLastDropState(null)
    },
    [clearPreviewTarget]
  )

  const handleDrop = useCallback(
    (targetPaneId: string, position: DropPosition, event: React.DragEvent) => {
      let payload = dragPayload

      if (!payload) {
        const raw = event.dataTransfer.getData('application/json')
        if (raw) {
          payload = parseDragPayload(raw)
        }
      }

      if (!payload) {
        setIsDragging(false)
        setDragPayload(null)
        clearPreviewTarget()
        return
      }

      const store = useWorkspaceStore.getState()

      if (payload.type === 'tab' && payload.tabId && payload.sourcePaneId) {
        // The move/split actions early-return on drops they reject — stamp
        // the signal only when the tree actually changed, otherwise a fresh
        // lastDrop could gate an unrelated mount inside the freshness window
        // (e.g. a fullscreen remount replaying the grow-in).
        const prevRoot = store.root
        if (position === 'center') {
          store.moveTabToPane(payload.tabId, payload.sourcePaneId, targetPaneId)
        } else {
          store.moveTabToNewSplit(payload.tabId, payload.sourcePaneId, targetPaneId, position)
        }
        if (useWorkspaceStore.getState().root !== prevRoot) {
          setLastDropState({ targetPaneId, position, at: Date.now() })
        }
      }

      if (payload.type === 'file' && payload.filePath) {
        const filePath = payload.filePath
        void useEditorStore
          .getState()
          .openFile(filePath)
          .then(() => {
            const currentStore = useWorkspaceStore.getState()

            // The target pane may have been removed while openFile was in
            // flight — no pane, no commit, no signal.
            if (!findPaneById(currentStore.root, targetPaneId)) {
              return
            }

            const tabId = editorTabId(filePath)
            const tab: WorkspaceTab = { type: 'editor', id: tabId, filePath }

            // openFile resolves asynchronously — stamp the drop signal at
            // commit time (and only when the tree actually changed) so the
            // freshness window starts when the drop takes effect, not when
            // it landed.
            const prevRoot = currentStore.root

            if (position === 'center') {
              currentStore.addTabToPane(targetPaneId, tab)
            } else {
              const direction =
                position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
              currentStore.splitPane(targetPaneId, direction, tab, position)
            }

            if (useWorkspaceStore.getState().root !== prevRoot) {
              setLastDropState({ targetPaneId, position, at: Date.now() })
            }
          })
          .catch(() => {
            // File couldn't be opened (binary, too large, etc.) — silently ignore
          })
      }

      setIsDragging(false)
      setDragPayload(null)
      clearPreviewTarget()
    },
    [dragPayload, clearPreviewTarget]
  )

  const handleTabReorder = useCallback(
    (sourcePaneId: string, targetTabId: string, position: TabReorderPosition) => {
      if (dragPayload?.type !== 'tab' || !dragPayload.tabId) {
        return
      }

      const sourceTabId = dragPayload.tabId

      // Don't reorder if dropping on self
      if (sourceTabId === targetTabId) {
        return
      }

      const store = useWorkspaceStore.getState()
      const pane = findPaneById(store.root, sourcePaneId)

      if (pane?.type !== 'leaf') {
        return
      }

      const tabs = pane.tabs
      const sourceIndex = tabs.findIndex((t: WorkspaceTab) => t.id === sourceTabId)
      const targetIndex = tabs.findIndex((t: WorkspaceTab) => t.id === targetTabId)

      if (sourceIndex === -1 || targetIndex === -1) {
        return
      }

      // Calculate new order
      const newTabs = [...tabs]
      const [movedTab] = newTabs.splice(sourceIndex, 1)

      // Adjust target index if source was before target
      let insertIndex = targetIndex
      if (sourceIndex < targetIndex) {
        insertIndex = targetIndex - 1
      }

      // Add offset for 'after' position
      if (position === 'after') {
        insertIndex += 1
      }

      newTabs.splice(insertIndex, 0, movedTab)

      store.reorderTabsInPane(
        sourcePaneId,
        newTabs.map((t: WorkspaceTab) => t.id)
      )
      clearReorderPreview()
    },
    [dragPayload, clearReorderPreview]
  )

  // Memoized: PaneSplitRenderer subscribes via usePaneDnd — a fresh object
  // every render would re-render every split group on each previewTarget
  // hover during a drag.
  const contextValue = useMemo<PaneDndContextValue>(
    () => ({
      isDragging,
      dragPayload,
      previewTarget,
      lastDrop,
      setPreviewTarget,
      clearPreviewTarget,
      reorderPreview,
      setReorderPreview,
      clearReorderPreview,
      startTabDrag,
      startFileDrag,
      handleDrop,
      handleTabReorder
    }),
    [
      isDragging,
      dragPayload,
      previewTarget,
      lastDrop,
      reorderPreview,
      setPreviewTarget,
      clearPreviewTarget,
      setReorderPreview,
      clearReorderPreview,
      startTabDrag,
      startFileDrag,
      handleDrop,
      handleTabReorder
    ]
  )

  return <PaneDndContext.Provider value={contextValue}>{children}</PaneDndContext.Provider>
}
