import { FileDiff } from '@/components/icons'
import { commitDiffTabLabel } from '@/lib/diff-tab-identity'
import { TabContextMenu, type TabContextMenuKind } from '../tab-context-menu'
import { TabChrome } from './tab-chrome'
import type { TabInlineProps } from './types'

interface DiffTabInlineProps extends TabInlineProps {
  tab: { type: 'diff'; id: string; cwd: string; path: string; staged: boolean }
}

interface CommitDiffTabInlineProps extends TabInlineProps {
  tab: { type: 'commit-diff'; id: string; cwd: string; commit: string; path: string }
}

/** Repo-relative POSIX path -> its last segment (the tab label). */
function basename(path: string): string {
  const segments = path.split(/[/]/).filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function DiffTabChrome({
  kind,
  label,
  title,
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
}: TabInlineProps & {
  kind: TabContextMenuKind
  label: string
  title: string
}): React.JSX.Element {
  return (
    <TabContextMenu kind={kind} onClose={onClose} {...bulkMenu}>
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
        icon={<FileDiff size={12} />}
        label={label}
        title={title}
        pinClose={isActive}
      />
    </TabContextMenu>
  )
}

export function DiffTabInline({ tab, ...props }: DiffTabInlineProps): React.JSX.Element {
  const side = tab.staged ? 'Staged' : 'Working tree'
  const name = basename(tab.path)
  return (
    <DiffTabChrome
      {...props}
      kind="diff"
      label={tab.staged ? `${name} (staged)` : name}
      title={`${tab.path} (${side})`}
    />
  )
}

/** Read-only diff of one file at one commit: `a.ts @ e44b917`. */
export function CommitDiffTabInline({
  tab,
  ...props
}: CommitDiffTabInlineProps): React.JSX.Element {
  return (
    <DiffTabChrome
      {...props}
      kind="commit-diff"
      label={commitDiffTabLabel(tab.path, tab.commit)}
      title={`${tab.path} (at ${tab.commit.slice(0, 7)})`}
    />
  )
}
