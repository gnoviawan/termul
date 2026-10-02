import { useShallow } from 'zustand/shallow'
import { cn } from '@/lib/utils'
import { useEditorStore } from '@/stores/editor-store'
import { EditorTab } from '../EditorTab'
import type { TabInlineProps } from './types'

interface EditorTabWrapperProps extends TabInlineProps {
  tab: { type: 'editor'; id: string; filePath: string }
  onCopyPath: () => void
}

export function EditorTabWrapper({
  tab,
  isActive,
  isDragging,
  isDropTarget,
  dropPosition,
  bulkMenu,
  onSelect,
  onClose,
  onCopyPath,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: EditorTabWrapperProps): React.JSX.Element {
  const { isDirty, operationStatus } = useEditorStore(
    useShallow((state) => {
      const file = state.openFiles.get(tab.filePath)
      return {
        isDirty: file?.isDirty ?? false,
        operationStatus: file?.operationStatus ?? 'idle'
      }
    })
  )
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'relative h-full transition-[opacity,transform] duration-150 ease-out',
        isDragging && 'opacity-50 scale-[0.98]'
      )}
    >
      {/* Drop indicator line */}
      {isDropTarget && dropPosition === 'before' && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full z-10" />
      )}
      {isDropTarget && dropPosition === 'after' && (
        <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-primary-fill rounded-full z-10" />
      )}
      <EditorTab
        filePath={tab.filePath}
        isActive={isActive}
        isDirty={isDirty}
        operationStatus={operationStatus}
        onSelect={onSelect}
        onClose={onClose}
        onCopyPath={onCopyPath}
        {...bulkMenu}
      />
    </div>
  )
}
