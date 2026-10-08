import { Edit2 } from '@/components/icons'
import { useCanvasStore } from '@/stores/canvas-store'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface CanvasTabInlineProps extends TabInlineProps {
  tab: { type: 'canvas'; id: string; projectId: string; docPath: string }
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/** Canvas tab (OpenPencil canvas mode): the dirty dot mirrors the editor's
 * unsaved marker; the label tracks the bound doc. */
export function CanvasTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  bulkMenu
}: CanvasTabInlineProps): React.JSX.Element {
  const dirty = useCanvasStore((state) => state.sessions[tab.projectId]?.dirty ?? false)

  return (
    <TabContextMenu kind="canvas" onClose={onClose} {...bulkMenu}>
      <TabChrome
        isActive={isActive}
        isDragging={isDragging}
        isDropTarget={isDropTarget}
        dropPosition={dropPosition}
        onSelect={onSelect}
        onClose={onClose}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        icon={<Edit2 size={12} />}
        label={basename(tab.docPath)}
        dirty={dirty}
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
