import type { GitDiffStat } from '@shared/types/ipc.types'
import { memo } from 'react'
import { ProjectIcon } from '@/components/ProjectIcon'
import { ProjectDiffStat } from '@/components/shell/ProjectDiffStat'
import {
  RailHoverPanel,
  RailHoverPanelContent,
  RailHoverPanelProjectRow,
  RailHoverPanelTrigger
} from '@/components/shell/rail/rail-hover-panel'
import { RAIL_ICON_BOX_CLASS } from '@/components/shell/rail-layout'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'

export interface ProjectIconItemProps {
  project: Project
  isActive: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  renderContextMenu?: (project: Project) => React.ReactNode
  /** Shown in the hover card; nothing when null. */
  diffStat?: GitDiffStat | null
}

/**
 * Project row of the collapsed Rail (Sidebar V2): the expanded row's 30px
 * with only the 16px project icon, centred (radius 6, hover 6% foreground,
 * the active project raised). Hover or keyboard focus opens the project card
 * (name + diff stat) at x = 52, on the row's y. Right-click opens the same
 * menu as the expanded row.
 */
export const ProjectIconItem = memo(function ProjectIconItem({
  project,
  isActive,
  onClick,
  onContextMenu,
  renderContextMenu,
  diffStat = null
}: ProjectIconItemProps): React.JSX.Element {
  return (
    <div data-testid={`project-item-${project.id}`}>
      <ContextMenu>
        <RailHoverPanel>
          <RailHoverPanelTrigger asChild>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={onClick}
                onContextMenu={onContextMenu}
                className={cn(
                  'flex h-7.5 w-full cursor-pointer select-none items-center justify-center rounded-md',
                  'transition-colors duration-150 ease-out focus-visible:ring-inset',
                  FOCUS_RING_CLASS,
                  isActive ? 'keycap' : 'hover:bg-foreground/[0.06]'
                )}
                aria-current={isActive ? 'page' : undefined}
                aria-label={`Project: ${project.name}${isActive ? ' (active)' : ''}`}
              >
                <span data-rail-icon-column className={RAIL_ICON_BOX_CLASS}>
                  <ProjectIcon project={project} size={16} />
                </span>
              </button>
            </ContextMenuTrigger>
          </RailHoverPanelTrigger>
          <RailHoverPanelContent data-testid="rail-project-card">
            <RailHoverPanelProjectRow
              icon={<ProjectIcon project={project} size={16} />}
              name={project.name}
            >
              {diffStat && <ProjectDiffStat stat={diffStat} />}
            </RailHoverPanelProjectRow>
          </RailHoverPanelContent>
        </RailHoverPanel>
        {renderContextMenu?.(project)}
      </ContextMenu>
    </div>
  )
})
