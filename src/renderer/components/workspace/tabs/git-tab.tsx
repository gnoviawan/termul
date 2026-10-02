import { GitBranch, X as XIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { type GitStatusState, useGitStatusStore } from '@/stores/git-status-store'
import { TAB_CLOSE_BUTTON_CLASS, TabCloseReveal } from '../EditorTab'
import { handleTabAuxClick, TabContextMenu } from '../tab-context-menu'
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
  bulkMenu,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop
}: GitTabInlineProps) {
  const totalChanges = useGitStatusStore(
    (state: GitStatusState) => (state.statuses[tab.cwd] || []).length
  )

  return (
    <TabContextMenu kind="git" onClose={onClose} {...bulkMenu}>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onSelect}
        onAuxClick={(e) => handleTabAuxClick(e, onClose)}
        className={cn(
          'group relative h-full px-3 flex items-center min-w-[120px] max-w-[200px] cursor-pointer select-none border-r border-border transition-[opacity,transform,background-color] duration-150 ease-out',
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
          isDragging && 'opacity-50 scale-[0.98]',
          isDropTarget && dropPosition === 'before' && 'border-l-2 border-l-primary',
          isDropTarget && dropPosition === 'after' && 'border-r-2 border-r-primary'
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={12} className={cn('shrink-0', isActive && 'text-primary')} />
          <span className="min-w-0 truncate text-2xs font-medium">Git Changes</span>
          {totalChanges > 0 && (
            <span
              className={cn(
                'px-1 min-w-[14px] h-3.5 flex shrink-0 items-center justify-center rounded-full text-4xs font-bold tabular-nums',
                isActive
                  ? 'bg-primary-fill text-primary-foreground'
                  : 'bg-muted-foreground/20 text-muted-foreground'
              )}
            >
              {totalChanges}
            </span>
          )}
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
