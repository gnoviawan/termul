import { Archive } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import { type ProjectRowStatus, ProjectStatusMarks } from './indicators'

export interface ArchivedProjectItemProps {
  project: Project
  status: ProjectRowStatus
  onOpenNeedsYou: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  renderContextMenu?: (project: Project) => React.ReactNode
}

export function ArchivedProjectItem({
  project,
  status,
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
          className="group flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 text-left text-xs opacity-60 transition-[opacity,background-color] duration-150 ease-out hover:bg-foreground/[0.03] hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`Archived project: ${project.name}`}
          data-testid={`archived-project-item-${project.id}`}
        >
          <span aria-hidden="true" className="size-4 shrink-0" />
          <ProjectIcon project={project} size={16} />
          <span
            aria-hidden="true"
            data-project-color={project.color}
            className={cn('size-2 shrink-0 rounded-full', colors.bg)}
          />
          <span
            className="min-w-0 flex-1 truncate font-medium text-secondary-foreground group-hover:text-foreground"
            title={project.name}
          >
            {project.name}
          </span>
          <ProjectStatusMarks status={status} onOpenNeedsYou={onOpenNeedsYou} />
          <Archive size={12} className="shrink-0 text-muted-foreground" />
        </button>
      </ContextMenuTrigger>
      {renderContextMenu?.(project)}
    </ContextMenu>
  )
}
