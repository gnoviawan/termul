import { memo, useCallback, useEffect, useRef } from 'react'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { usePaneDnd } from '@/hooks/use-pane-dnd'
import { usePaneSplitAnimation } from '@/hooks/use-pane-split-animation'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import { useProjectPaneContext } from '@/stores/workspace-store/pane-context'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import { PaneContent } from './PaneContent'

interface PaneRendererProps {
  node: PaneNode
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  closingTerminalIds?: string[]
}

export function PaneRenderer({
  node,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  onCloseTabs,
  closingTerminalIds
}: PaneRendererProps): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <PaneLeafRenderer
        pane={node}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        onCloseTabs={onCloseTabs}
        closingTerminalIds={closingTerminalIds}
      />
    )
  }
  return (
    <PaneSplitRenderer
      node={node}
      onCloseTerminal={onCloseTerminal}
      onRenameTerminal={onRenameTerminal}
      onCloseEditorTab={onCloseEditorTab}
      onCloseTabs={onCloseTabs}
      closingTerminalIds={closingTerminalIds}
    />
  )
}

interface PaneLeafRendererProps {
  pane: LeafNode
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  closingTerminalIds?: string[]
}

const PaneLeafRenderer = memo(
  ({
    pane,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    onCloseTabs,
    closingTerminalIds
  }: PaneLeafRendererProps): React.JSX.Element => {
    return (
      <ErrorBoundary context="Terminal Pane">
        <PaneContent
          pane={pane}
          onCloseTerminal={onCloseTerminal}
          onRenameTerminal={onRenameTerminal}
          onCloseEditorTab={onCloseEditorTab}
          onCloseTabs={onCloseTabs}
          closingTerminalIds={closingTerminalIds}
        />
      </ErrorBoundary>
    )
  }
)

interface PaneSplitRendererProps {
  node: SplitNode
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  closingTerminalIds?: string[]
}

const PaneSplitRenderer = memo(
  ({
    node,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    onCloseTabs,
    closingTerminalIds
  }: PaneSplitRendererProps): React.JSX.Element => {
    const updatePaneSizes = useWorkspaceStore((state) => state.updatePaneSizes)
    // Resizes of a hidden-but-mounted tree must land in that project's tree.
    const paneProjectId = useProjectPaneContext()?.projectId
    const pendingSizesRef = useRef<number[] | null>(null)
    const isDraggingRef = useRef(false)
    const groupRef = useRef<ImperativePanelGroupHandle>(null)
    const { lastDrop } = usePaneDnd()

    // Drop-created layout tween: new panes grow in / neighbors settle via
    // imperative setLayout instead of snapping. No-ops on non-drop mounts,
    // during handle drags, and under prefers-reduced-motion.
    const isTweeningLayoutRef = usePaneSplitAnimation({
      nodeId: node.id,
      children: node.children,
      sizes: node.sizes,
      groupRef,
      isDraggingRef,
      lastDrop
    })

    const handleLayout = useCallback(
      (sizes: number[]) => {
        // While the drop tween drives setLayout it re-fires onLayout every
        // frame — the store already holds the target sizes, so skip writes
        // (and keep pendingSizes clean) until the tween ends.
        if (isTweeningLayoutRef.current) {
          return
        }
        pendingSizesRef.current = sizes
        // Only commit to store when not actively dragging to prevent
        // re-render feedback loop that fights with the drag direction
        if (!isDraggingRef.current) {
          updatePaneSizes(node.id, sizes, paneProjectId)
          pendingSizesRef.current = null
        }
      },
      [node.id, updatePaneSizes, paneProjectId, isTweeningLayoutRef]
    )

    const handleDragging = useCallback(
      (dragging: boolean) => {
        isDraggingRef.current = dragging
        if (!dragging && pendingSizesRef.current) {
          // Drag ended — flush pending sizes to the store
          updatePaneSizes(node.id, pendingSizesRef.current, paneProjectId)
          pendingSizesRef.current = null
        }
      },
      [node.id, updatePaneSizes, paneProjectId]
    )

    useEffect(() => {
      return () => {
        // If this split unmounts while a drag is active, do not leak drag state
        isDraggingRef.current = false
        pendingSizesRef.current = null
      }
    }, [])

    return (
      <ResizablePanelGroup
        ref={groupRef}
        id={node.id}
        direction={node.direction}
        onLayout={handleLayout}
      >
        {node.children.map((child, index) => (
          <PaneRendererPanel
            key={child.id}
            child={child}
            panelOrder={index}
            defaultSize={node.sizes[index] ?? 50}
            isLast={index === node.children.length - 1}
            onDragging={handleDragging}
            onCloseTerminal={onCloseTerminal}
            onRenameTerminal={onRenameTerminal}
            onCloseEditorTab={onCloseEditorTab}
            onCloseTabs={onCloseTabs}
            closingTerminalIds={closingTerminalIds}
          />
        ))}
      </ResizablePanelGroup>
    )
  }
)

interface PaneRendererPanelProps {
  child: PaneNode
  panelOrder: number
  defaultSize: number
  isLast: boolean
  onDragging: (isDragging: boolean) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  closingTerminalIds?: string[]
}

const PaneRendererPanel = memo(
  ({
    child,
    panelOrder,
    defaultSize,
    isLast,
    onDragging,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    onCloseTabs,
    closingTerminalIds
  }: PaneRendererPanelProps): React.JSX.Element => {
    return (
      <>
        <ResizablePanel id={child.id} order={panelOrder} defaultSize={defaultSize} minSize={10}>
          <PaneRenderer
            node={child}
            onCloseTerminal={onCloseTerminal}
            onRenameTerminal={onRenameTerminal}
            onCloseEditorTab={onCloseEditorTab}
            onCloseTabs={onCloseTabs}
            closingTerminalIds={closingTerminalIds}
          />
        </ResizablePanel>
        {!isLast && <ResizableHandle onDragging={onDragging} />}
      </>
    )
  }
)
