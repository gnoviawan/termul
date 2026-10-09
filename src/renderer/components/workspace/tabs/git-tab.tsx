import { GitBranch } from '@/components/icons'
import { CountBadge } from '@/components/ui/count-badge'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface GitTabInlineProps extends TabInlineProps {
  tab: { type: 'git'; id: string; cwd: string }
}

export function GitTabInline({
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
}: GitTabInlineProps): React.JSX.Element {
  const totalChanges = useGitStatusStore(selectChangedFileCount(tab.cwd))

  return (
    <TabContextMenu kind="git" onClose={onClose} {...bulkMenu}>
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
        icon={<GitBranch size={12} />}
        label="Git Changes"
        after={
          totalChanges > 0 ? (
            <CountBadge count={totalChanges} className="h-4 min-w-[14px] shrink-0 text-3xs" />
          ) : undefined
        }
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
