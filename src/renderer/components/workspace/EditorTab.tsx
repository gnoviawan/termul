import { useShallow } from 'zustand/shallow'
import { MaterialFileIcon } from '@/components/file-explorer/MaterialFileIcon'
import { useEditorStore } from '@/stores/editor-store'
import { type TabBulkMenuProps, TabContextMenu } from './tab-context-menu'
import { TabChrome } from './tabs/tab-chrome'
import type { TabInlineProps } from './tabs/types'

function getBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

function getExtname(filePath: string): string {
  const name = getBasename(filePath)
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex)
}

export interface EditorTabProps extends TabInlineProps {
  tab: { type: 'editor'; id: string; filePath: string }
  bulkMenu: TabBulkMenuProps
  onSelect: () => void
  onClose: () => void
  onCopyPath?: () => void
}

export function EditorTab({
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
}: EditorTabProps): React.JSX.Element {
  const fileName = getBasename(tab.filePath)
  const ext = getExtname(tab.filePath).slice(1) || null

  const { isDirty, operationStatus } = useEditorStore(
    useShallow((state) => {
      const file = state.openFiles.get(tab.filePath)
      return {
        isDirty: file?.isDirty ?? false,
        operationStatus: file?.operationStatus ?? 'idle'
      }
    })
  )

  const isBusy = operationStatus === 'saving' || operationStatus === 'reloading'
  const showSuccess = operationStatus === 'saved'
  // The accessible name must describe the action: 'saved' is only a visual
  // flash (Check icon), the button still closes the tab.
  const closeLabel =
    operationStatus === 'saving'
      ? 'Saving file'
      : operationStatus === 'reloading'
        ? 'Reloading file'
        : operationStatus === 'saved'
          ? `Close ${fileName}`
          : 'Close tab'

  return (
    <TabContextMenu
      kind="editor"
      {...bulkMenu}
      onClose={onClose}
      isBusy={isBusy}
      onCopyPath={onCopyPath}
    >
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
        icon={
          <MaterialFileIcon
            name={fileName}
            extension={ext}
            isDirectory={false}
            isExpanded={false}
            depth={0}
            size={12}
          />
        }
        label={fileName}
        dirty={isDirty}
        closeDisabled={isBusy}
        // 'saved' is a transient success flash, not a close guard: only a
        // real save/reload in flight blocks closing.
        closeContent={isBusy ? 'spinner' : showSuccess ? 'check' : 'default'}
        pinClose={isActive || showSuccess}
        closeAriaLabel={closeLabel}
      />
    </TabContextMenu>
  )
}
