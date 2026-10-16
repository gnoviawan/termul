import type { GitDiffStat } from '@shared/types/ipc.types'
import { type KeyboardEvent, memo, useEffect, useRef } from 'react'
import { Settings } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { RAIL_ICON_BOX_CLASS, RAIL_ROW_INSET_CLASS } from '@/components/shell/rail-layout'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Kbd } from '@/components/ui/kbd'
import { FIELD_FOCUS_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import { ProjectDiffStat } from '../shell/ProjectDiffStat'
import { type ProjectRowStatus, ProjectStatusMarks } from './indicators'

export interface ProjectItemProps {
  project: Project
  isActive: boolean
  isEditing: boolean
  editName: string
  shortcut?: string
  status: ProjectRowStatus
  onOpenNeedsYou: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onEditNameChange: (name: string) => void
  onSaveRename: () => void
  onCancelRename: () => void
  onSettingsClick: () => void
  renderContextMenu?: (project: Project) => React.ReactNode
  /** Uncommitted line stat for the row (see `RailProjectItem`); nothing when null. */
  diffStat?: GitDiffStat | null
}

export const ProjectItem = memo(function ProjectItem({
  project,
  isActive,
  isEditing,
  editName,
  shortcut,
  status,
  onOpenNeedsYou,
  onClick,
  onContextMenu,
  onEditNameChange,
  onSaveRename,
  onCancelRename,
  onSettingsClick,
  renderContextMenu,
  diffStat: watchedDiffStat = null
}: ProjectItemProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  // At rest the stat holds the right slot; hover or focus swaps it for the
  // settings gear and shortcut chip. It yields to the rename input.
  const diffStat = isEditing ? null : watchedDiffStat

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSaveRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancelRename()
    }
  }

  return (
    <div data-testid={`project-item-${project.id}`}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onClick={isEditing ? undefined : onClick}
            onContextMenu={onContextMenu}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (!isEditing) onClick()
              }
            }}
            className={cn(
              'group flex h-8 w-full cursor-pointer select-none items-center pr-1.5 text-left text-xs',
              'rounded-lg',
              RAIL_ROW_INSET_CLASS,
              'transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isActive ? 'keycap text-foreground' : 'hover:bg-row-hover focus-within:bg-row-hover'
            )}
            aria-current={isActive ? 'page' : undefined}
            aria-label={`Project: ${project.name}${isActive ? ' (active)' : ''}`}
          >
            <span data-rail-icon-column className={RAIL_ICON_BOX_CLASS}>
              <ProjectIcon project={project} size={16} />
            </span>

            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={onSaveRename}
                className={`h-6 min-w-0 flex-1 rounded border border-border bg-card px-1.5 text-xs text-foreground ${FIELD_FOCUS_CLASS}`}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              // Name and diff stat share one box whose width never changes on
              // hover: the actions sit on top of its end, over a fade, so
              // nothing reflows and the name is not cut again.
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={cn(
                    // flex-1 min-w-0 is required for truncate to clip inside a flex row
                    'min-w-0 flex-1 truncate font-medium transition-colors duration-150 ease-out',
                    isActive
                      ? 'text-foreground'
                      : 'text-secondary-foreground group-hover:text-foreground'
                  )}
                  title={project.name}
                >
                  {project.name}
                </span>
                {diffStat && (
                  <span className="flex shrink-0">
                    <ProjectDiffStat stat={diffStat} />
                  </span>
                )}
                <span
                  className={cn(
                    'absolute inset-y-0 right-0 hidden items-center gap-1 bg-gradient-to-l to-transparent pl-6 group-hover:flex group-focus-within:flex',
                    // The fade ends in the row's own surface: the Rail keycap
                    // fill when active, the hover wash otherwise. It shows
                    // under the same conditions as the wash (hover and
                    // focus-within).
                    isActive
                      ? 'from-[var(--rail-keycap)] from-60%'
                      : 'from-row-hover-solid from-60%'
                  )}
                  data-testid="project-row-actions"
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSettingsClick()
                    }}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title="Project settings"
                    aria-label={`Settings for ${project.name}`}
                  >
                    <Settings size={12} />
                  </button>
                  {shortcut && (
                    <Kbd className="inline-flex h-4.5 shrink-0 items-center px-1">{shortcut}</Kbd>
                  )}
                </span>
              </span>
            )}
            {/* Status marks stay outside the name box: always visible, and the
                needs-you pill stays clickable. The activity spinner yields to
                the rename input. */}
            <ProjectStatusMarks
              status={isEditing && status.live === 'activity' ? { ...status, live: null } : status}
              onOpenNeedsYou={onOpenNeedsYou}
            />
          </div>
        </ContextMenuTrigger>
        {renderContextMenu?.(project)}
      </ContextMenu>
    </div>
  )
})
