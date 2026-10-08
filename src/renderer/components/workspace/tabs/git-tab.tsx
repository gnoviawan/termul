import { GitBranch } from '@/components/icons'
import { type GitStatusState, useGitStatusStore } from '@/stores/git-status-store'
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
  const totalChanges = useGitStatusStore(
    (state: GitStatusState) => (state.statuses[tab.cwd] || []).length
  )

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
            <span className="flex h-4 min-w-[14px] shrink-0 items-center justify-center rounded-full bg-foreground/10 px-1 text-3xs font-semibold leading-none tabular-nums text-muted-foreground">
              {totalChanges}
            </span>
          ) : undefined
        }
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
