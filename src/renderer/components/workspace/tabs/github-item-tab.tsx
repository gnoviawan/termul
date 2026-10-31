import { githubItemTabLabel, ItemStateIcon } from '@/components/github/github-status'
import { githubItemKey, useGithubStore } from '@/stores/github-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { TabContextMenu } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface GithubItemTabInlineProps extends TabInlineProps {
  tab: Extract<WorkspaceTab, { type: 'github-item' }>
}

export function GithubItemTabInline({
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
}: GithubItemTabInlineProps): React.JSX.Element {
  const item = useGithubStore(
    (state) => state.items[githubItemKey(tab.cwd, tab.repo, tab.number)]?.data?.item
  )
  return (
    <TabContextMenu kind="github-item" onClose={onClose} {...bulkMenu}>
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
        icon={<ItemStateIcon kind={tab.kind} state={item?.state ?? 'open'} size={12} />}
        // The loaded detail's title wins over the one stored when the tab opened.
        label={githubItemTabLabel(tab.number, item?.title ?? tab.title)}
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}
