import { History } from '@/components/icons'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface GitHistoryTabInlineProps extends TabInlineProps {
  tab: { type: 'git-history'; id: string; cwd: string }
}

export function GitHistoryTabInline({
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
}: GitHistoryTabInlineProps): React.JSX.Element {
  return (
    <TabContextMenu kind="git-history" onClose={onClose} {...bulkMenu}>
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
        icon={<History size={12} />}
        label="Git History"
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
