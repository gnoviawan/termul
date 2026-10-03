import { Edit2, X as XIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useCanvasStore } from '@/stores/canvas-store'
import { TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from '../EditorTab'
import { handleTabAuxClick, TabContextMenu } from '../tab-context-menu'
import type { TabInlineProps } from './types'

interface CanvasTabInlineProps extends TabInlineProps {
  tab: { type: 'canvas'; id: string; projectId: string; docPath: string }
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/** Canvas tab chrome (OpenPencil canvas mode): the dirty dot mirrors the
 * EditorTab `bg-primary-fill` indicator; the label tracks the bound doc. */
export function CanvasTabInline({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: CanvasTabInlineProps): React.JSX.Element {
  const dirty = useCanvasStore((state) => state.sessions[tab.projectId]?.dirty ?? false)

  return (
    <TabContextMenu kind="canvas" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[110px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {dirty && <span className="mr-1 h-2 w-2 shrink-0 rounded-full bg-primary-fill" />}
          <Edit2 size={12} className={cn('shrink-0', isActive && 'text-primary')} />
          <span className="min-w-0 truncate text-2xs font-medium">{basename(tab.docPath)}</span>
        </div>
        <TabCloseReveal pinned={isActive}>
          <button
            type="button"
            tabIndex={isActive ? undefined : -1}
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className={TAB_CLOSE_BUTTON_CLASS}
          >
            <XIcon size={10} />
          </button>
        </TabCloseReveal>
      </div>
    </TabContextMenu>
  )
}
