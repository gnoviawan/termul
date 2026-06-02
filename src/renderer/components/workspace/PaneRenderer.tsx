import type { ShellInfo } from '@shared/types/ipc.types'
import { memo, useCallback, useEffect, useRef } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import { PaneContent } from './PaneContent'

interface PaneRendererProps {
  node: PaneNode
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

export function PaneRenderer({
  node,
  onAddTerminal,
  onAddBrowserTab,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  closingTerminalIds,
  defaultShell
}: PaneRendererProps): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <PaneLeafRenderer
        pane={node}
        onAddTerminal={onAddTerminal}
        onAddBrowserTab={onAddBrowserTab}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        closingTerminalIds={closingTerminalIds}
        defaultShell={defaultShell}
      />
    )
  }
  return (
    <PaneSplitRenderer
      node={node}
      onAddTerminal={onAddTerminal}
      onAddBrowserTab={onAddBrowserTab}
      onCloseTerminal={onCloseTerminal}
      onRenameTerminal={onRenameTerminal}
      onCloseEditorTab={onCloseEditorTab}
      closingTerminalIds={closingTerminalIds}
      defaultShell={defaultShell}
    />
  )
}

interface PaneLeafRendererProps {
  pane: LeafNode
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

const PaneLeafRenderer = memo(
  ({
    pane,
    onAddTerminal,
    onAddBrowserTab,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    closingTerminalIds,
    defaultShell
  }: PaneLeafRendererProps): React.JSX.Element => {
    return (
      <ErrorBoundary context="Terminal Pane">
        <PaneContent
          pane={pane}
          onAddTerminal={onAddTerminal}
          onAddBrowserTab={onAddBrowserTab}
          onCloseTerminal={onCloseTerminal}
          onRenameTerminal={onRenameTerminal}
          onCloseEditorTab={onCloseEditorTab}
          closingTerminalIds={closingTerminalIds}
          defaultShell={defaultShell}
        />
      </ErrorBoundary>
    )
  }
)

interface PaneSplitRendererProps {
  node: SplitNode
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

const PaneSplitRenderer = memo(
  ({
    node,
    onAddTerminal,
    onAddBrowserTab,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    closingTerminalIds,
    defaultShell
  }: PaneSplitRendererProps): React.JSX.Element => {
    const updatePaneSizes = useWorkspaceStore((state) => state.updatePaneSizes)
    const pendingSizesRef = useRef<number[] | null>(null)
    const isDraggingRef = useRef(false)

    const handleLayout = useCallback(
      (sizes: number[]) => {
        pendingSizesRef.current = sizes
        // Only commit to store when not actively dragging to prevent
        // re-render feedback loop that fights with the drag direction
        if (!isDraggingRef.current) {
          updatePaneSizes(node.id, sizes)
          pendingSizesRef.current = null
        }
      },
      [node.id, updatePaneSizes]
    )

    const handleDragging = useCallback(
      (dragging: boolean) => {
        isDraggingRef.current = dragging
        if (!dragging && pendingSizesRef.current) {
          // Drag ended — flush pending sizes to the store
          updatePaneSizes(node.id, pendingSizesRef.current)
          pendingSizesRef.current = null
        }
      },
      [node.id, updatePaneSizes]
    )

    useEffect(() => {
      return () => {
        // If this split unmounts while a drag is active, do not leak drag state
        isDraggingRef.current = false
        pendingSizesRef.current = null
      }
    }, [])

    return (
      <ResizablePanelGroup id={node.id} direction={node.direction} onLayout={handleLayout}>
        {node.children.map((child, index) => (
          <PaneRendererPanel
            key={child.id}
            child={child}
            panelOrder={index}
            defaultSize={node.sizes[index] ?? 50}
            isLast={index === node.children.length - 1}
            onDragging={handleDragging}
            onAddTerminal={onAddTerminal}
            onAddBrowserTab={onAddBrowserTab}
            onCloseTerminal={onCloseTerminal}
            onRenameTerminal={onRenameTerminal}
            onCloseEditorTab={onCloseEditorTab}
            closingTerminalIds={closingTerminalIds}
            defaultShell={defaultShell}
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
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

const PaneRendererPanel = memo(
  ({
    child,
    panelOrder,
    defaultSize,
    isLast,
    onDragging,
    onAddTerminal,
    onAddBrowserTab,
    onCloseTerminal,
    onRenameTerminal,
    onCloseEditorTab,
    closingTerminalIds,
    defaultShell
  }: PaneRendererPanelProps): React.JSX.Element => {
    return (
      <>
        <ResizablePanel id={child.id} order={panelOrder} defaultSize={defaultSize} minSize={10}>
          <PaneRenderer
            node={child}
            onAddTerminal={onAddTerminal}
            onAddBrowserTab={onAddBrowserTab}
            onCloseTerminal={onCloseTerminal}
            onRenameTerminal={onRenameTerminal}
            onCloseEditorTab={onCloseEditorTab}
            closingTerminalIds={closingTerminalIds}
            defaultShell={defaultShell}
          />
        </ResizablePanel>
        {!isLast && <ResizableHandle onDragging={onDragging} />}
      </>
    )
  }
)
