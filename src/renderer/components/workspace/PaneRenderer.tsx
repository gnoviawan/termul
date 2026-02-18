import { useCallback, useEffect, useRef, memo } from 'react'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@/components/ui/resizable'
import { PaneContent } from './PaneContent'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { PaneNode, SplitNode, LeafNode } from '@/types/workspace.types'
import type { ShellInfo } from '@shared/types/ipc.types'

interface PaneRendererProps {
  node: PaneNode
  onNewTerminal?: (paneId: string) => void
  onNewTerminalWithShell?: (paneId: string, shell: ShellInfo) => void
  onCloseTerminal?: (id: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  defaultShell?: string
}

export function PaneRenderer({
  node,
  onNewTerminal,
  onNewTerminalWithShell,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  defaultShell
}: PaneRendererProps): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <PaneLeafRenderer
        pane={node}
        onNewTerminal={onNewTerminal}
        onNewTerminalWithShell={onNewTerminalWithShell}
        onCloseTerminal={onCloseTerminal}
        onRenameTerminal={onRenameTerminal}
        onCloseEditorTab={onCloseEditorTab}
        defaultShell={defaultShell}
      />
    )
  }
  return (
    <PaneSplitRenderer
      node={node}
      onNewTerminal={onNewTerminal}
      onNewTerminalWithShell={onNewTerminalWithShell}
      onCloseTerminal={onCloseTerminal}
      onRenameTerminal={onRenameTerminal}
      onCloseEditorTab={onCloseEditorTab}
      defaultShell={defaultShell}
    />
  )
}

interface PaneLeafRendererProps {
  pane: LeafNode
  onNewTerminal?: (paneId: string) => void
  onNewTerminalWithShell?: (paneId: string, shell: ShellInfo) => void
  onCloseTerminal?: (id: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  defaultShell?: string
}

function PaneLeafRenderer({
  pane,
  onNewTerminal,
  onNewTerminalWithShell,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  defaultShell
}: PaneLeafRendererProps): React.JSX.Element {
  return (
    <PaneContent
      pane={pane}
      onNewTerminal={onNewTerminal}
      onNewTerminalWithShell={onNewTerminalWithShell}
      onCloseTerminal={onCloseTerminal}
      onRenameTerminal={onRenameTerminal}
      onCloseEditorTab={onCloseEditorTab}
      defaultShell={defaultShell}
    />
  )
}

interface PaneSplitRendererProps {
  node: SplitNode
  onNewTerminal?: (paneId: string) => void
  onNewTerminalWithShell?: (paneId: string, shell: ShellInfo) => void
  onCloseTerminal?: (id: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  defaultShell?: string
}

function PaneSplitRenderer({
  node,
  onNewTerminal,
  onNewTerminalWithShell,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  defaultShell
}: PaneSplitRendererProps): React.JSX.Element {
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
    <ResizablePanelGroup
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
          onNewTerminal={onNewTerminal}
          onNewTerminalWithShell={onNewTerminalWithShell}
          onCloseTerminal={onCloseTerminal}
          onRenameTerminal={onRenameTerminal}
          onCloseEditorTab={onCloseEditorTab}
          defaultShell={defaultShell}
        />
      ))}
    </ResizablePanelGroup>
  )
}

interface PaneRendererPanelProps {
  child: PaneNode
  panelOrder: number
  defaultSize: number
  isLast: boolean
  onDragging: (isDragging: boolean) => void
  onNewTerminal?: (paneId: string) => void
  onNewTerminalWithShell?: (paneId: string, shell: ShellInfo) => void
  onCloseTerminal?: (id: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  defaultShell?: string
}

const PaneRendererPanel = memo(function PaneRendererPanel({
  child,
  panelOrder,
  defaultSize,
  isLast,
  onDragging,
  onNewTerminal,
  onNewTerminalWithShell,
  onCloseTerminal,
  onRenameTerminal,
  onCloseEditorTab,
  defaultShell
}: PaneRendererPanelProps): React.JSX.Element {
  return (
    <>
      <ResizablePanel
        id={child.id}
        order={panelOrder}
        defaultSize={defaultSize}
        minSize={10}
      >
        <PaneRenderer
          node={child}
          onNewTerminal={onNewTerminal}
          onNewTerminalWithShell={onNewTerminalWithShell}
          onCloseTerminal={onCloseTerminal}
          onRenameTerminal={onRenameTerminal}
          onCloseEditorTab={onCloseEditorTab}
          defaultShell={defaultShell}
        />
      </ResizablePanel>
      {!isLast && <ResizableHandle onDragging={onDragging} />}
    </>
  )
})
