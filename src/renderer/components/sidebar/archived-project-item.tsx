import { AlertTriangle, Archive, Folder } from '@/components/icons'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Spinner } from '@/components/ui/spinner'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import { NeedsYouButton, RunningMark } from './indicators'

export interface ArchivedProjectItemProps {
  hasActivity: boolean
  hasError?: boolean
  attentionCount?: number
  running?: boolean
  onOpenNeedsYou?: () => void
  project: Project
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  renderContextMenu?: (project: Project) => React.ReactNode
}

export function ArchivedProjectItem({
  project,
  hasActivity,
  hasError,
  attentionCount = 0,
  running = false,
  onOpenNeedsYou,
  onClick,
  onContextMenu,
  renderContextMenu
}: ArchivedProjectItemProps): React.JSX.Element {
  const colors = getColorClasses(project.color)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          onContextMenu={onContextMenu}
          className={cn(
            'w-full flex items-center px-0 py-1 transition-colors group text-left border-l-2 opacity-60 hover:opacity-100',
            colors.borderMuted
          )}
          aria-label={`Archived project: ${project.name}`}
          data-testid={`archived-project-item-${project.id}`}
        >
          <Folder
            size={13}
            className="ml-2 mr-1.5 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span
            className="text-sm text-muted-foreground group-hover:text-foreground flex-1 min-w-0 truncate mr-2"
            title={project.name}
          >
            {project.name}
          </span>
          {hasActivity && (
            <span className="flex items-center mr-2 text-muted-foreground" title="Activity">
              <Spinner size={12} label="Project activity" />
            </span>
          )}
          {running ? <RunningMark /> : null}
          <NeedsYouButton count={attentionCount} onOpen={onOpenNeedsYou} />
          {hasError && (
            <span
              className="flex items-center mr-2 text-warning animate-pulse"
              title="Terminal crashed"
            >
              <AlertTriangle size={10} />
            </span>
          )}
          <Archive size={12} className="text-muted-foreground mr-3" />
        </button>
      </ContextMenuTrigger>
      {renderContextMenu?.(project)}
    </ContextMenu>
  )
}
