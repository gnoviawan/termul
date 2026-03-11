import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useWorkspaceStore, findPaneById } from '@/stores/workspace-store'
import { useEditorStore } from '@/stores/editor-store'
import { editorTabId } from '@/stores/workspace-store'
import type { DragPayload, DropPosition, TabReorderPosition } from '@/types/workspace.types'
import type { WorkspaceTab } from '@/stores/workspace-store'

interface DropPreviewTarget {
  paneId: string
  position: DropPosition
}

export interface ReorderPreview {
  paneId: string
  targetTabId: string
  position: TabReorderPosition
}

interface PaneDndContextValue {
  isDragging: boolean
  dragPayload: DragPayload | null
  previewTarget: DropPreviewTarget | null
  setPreviewTarget: (paneId: string, position: DropPosition) => void
  clearPreviewTarget: (paneId?: string, position?: DropPosition) => void
  reorderPreview: ReorderPreview | null
  setReorderPreview: (paneId: string, targetTabId: string, position: TabReorderPosition) => void
  clearReorderPreview: () => void
  startTabDrag: (tabId: string, paneId: string, event: React.DragEvent) => void
  startFileDrag: (filePath: string, event: React.DragEvent) => void
  handleDrop: (targetPaneId: string, position: DropPosition, event: React.DragEvent) => void
  handleTabReorder: (sourcePaneId: string, targetTabId: string, position: TabReorderPosition) => void
}

const PaneDndContext = createContext<PaneDndContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function usePaneDnd(): PaneDndContextValue {
  const ctx = useContext(PaneDndContext)
  if (!ctx) {
    throw new Error('usePaneDnd must be used within a PaneDndProvider')
  }
  return ctx
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
        if (position === 'center') {
          store.moveTabToPane(payload.tabId, payload.sourcePaneId, targetPaneId)
        } else {
          store.moveTabToNewSplit(payload.tabId, payload.sourcePaneId, targetPaneId, position)
        }
      }

      if (payload.type === 'file' && payload.filePath) {
        const filePath = payload.filePath
        void useEditorStore
          .getState()
          .openFile(filePath)
          .then(() => {
            const currentStore = useWorkspaceStore.getState()
            const tabId = editorTabId(filePath)
            const tab: WorkspaceTab = { type: 'editor', id: tabId, filePath }

            if (position === 'center') {
              currentStore.addTabToPane(targetPaneId, tab)
              return
            }

            const direction =
              position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
            currentStore.splitPane(targetPaneId, direction, tab, position)
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
      if (!dragPayload || dragPayload.type !== 'tab' || !dragPayload.tabId) {
        return
      }

      const sourceTabId = dragPayload.tabId

      // Don't reorder if dropping on self
      if (sourceTabId === targetTabId) {
        return
      }

      const store = useWorkspaceStore.getState()
      const pane = findPaneById(store.root, sourcePaneId)

      if (!pane || pane.type !== 'leaf') {
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

      store.reorderTabsInPane(sourcePaneId, newTabs.map((t: WorkspaceTab) => t.id))
      clearReorderPreview()
    },
    [dragPayload, clearReorderPreview]
  )

  return (
    <PaneDndContext.Provider
      value={{
        isDragging,
        dragPayload,
        previewTarget,
        setPreviewTarget,
        clearPreviewTarget,
        reorderPreview,
        setReorderPreview,
        clearReorderPreview,
        startTabDrag,
        startFileDrag,
        handleDrop,
        handleTabReorder
      }}
    >
      {children}
    </PaneDndContext.Provider>
  )
}
