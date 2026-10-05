import { AlertTriangle, Archive } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
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
          className="w-full flex items-center px-0 py-1 transition-colors group text-left opacity-60 hover:opacity-100"
          aria-label={`Archived project: ${project.name}`}
          data-testid={`archived-project-item-${project.id}`}
        >
          <ProjectIcon project={project} size={13} className="ml-2 mr-1.5" />
          <span
            aria-hidden="true"
            data-project-color={project.color}
            className={cn('mr-1.5 size-2 shrink-0 rounded-full', colors.bg)}
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
