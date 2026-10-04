import { type KeyboardEvent, memo, useEffect, useRef } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Settings } from '@/components/icons'
import { ProjectIcon } from '@/components/ProjectIcon'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'
import { ProjectChatList } from '../ProjectChatList'
import { NeedsYouButton, RunningMark } from './indicators'

export interface ProjectItemProps {
  project: Project
  isActive: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  isEditing: boolean
  editName: string
  shortcut?: string
  hasActivity: boolean
  hasError?: boolean
  attentionCount?: number
  running?: boolean
  onOpenNeedsYou?: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onEditNameChange: (name: string) => void
  onSaveRename: () => void
  onCancelRename: () => void
  onSettingsClick: () => void
  renderContextMenu?: (project: Project) => React.ReactNode
}

export const ProjectItem = memo(function ProjectItem({
  project,
  isActive,
  isExpanded,
  onToggleExpand,
  isEditing,
  editName,
  shortcut,
  hasActivity,
  hasError,
  attentionCount = 0,
  running = false,
  onOpenNeedsYou,
  onClick,
  onContextMenu,
  onEditNameChange,
  onSaveRename,
  onCancelRename,
  onSettingsClick,
  renderContextMenu
}: ProjectItemProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

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
              'w-full flex items-center px-0 py-1 transition-colors group text-left cursor-pointer select-none',
              isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'
            )}
            aria-current={isActive ? 'page' : undefined}
            aria-label={`Project: ${project.name}${isActive ? ' (active)' : ''}`}
          >
            {/* Expand/collapse chevron — every project can have chats, so the
            chevron always shows (not only git projects). */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              className="h-5 w-5 inline-flex items-center justify-center flex-shrink-0 hover:bg-sidebar-accent rounded transition-colors"
              aria-label={isExpanded ? 'Collapse chats' : 'Expand chats'}
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <ChevronDown size={12} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={12} className="text-muted-foreground" />
              )}
            </button>

            <ProjectIcon project={project} size={13} className="mr-1.5" />

            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => onEditNameChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={onSaveRename}
                className="flex-1 min-w-0 bg-sidebar-accent border border-border rounded-md px-2 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary mr-2"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className={cn(
                  'text-sm transition-colors flex-1 min-w-0 truncate mr-2',
                  // flex-1 min-w-0 is required for truncate to clip inside a flex row
                  isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                )}
                title={project.name}
              >
                {project.name}
              </span>
            )}
            {running ? <RunningMark /> : null}
            <NeedsYouButton count={attentionCount} onOpen={onOpenNeedsYou} />
            {hasError && (
              <span
                className="flex items-center mr-2 text-warning animate-pulse"
                title="Terminal crashed"
              >
                <AlertTriangle size={12} />
              </span>
            )}
            {!isEditing && shortcut && (
              <span
                className={cn(
                  'text-xs font-mono text-muted-foreground transition-opacity mr-3',
                  isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
              >
                {shortcut}
              </span>
            )}
            {!isEditing && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onSettingsClick()
                }}
                className="h-5 w-5 inline-flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-sidebar-accent transition-all mr-2 flex-shrink-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                title="Project settings"
                aria-label={`Settings for ${project.name}`}
              >
                <Settings size={12} className="text-muted-foreground" />
              </button>
            )}
            {!isEditing && hasActivity && (
              <span className="flex items-center mr-3 text-muted-foreground" title="Activity">
                <Spinner size={12} label="Project activity" />
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        {renderContextMenu?.(project)}
      </ContextMenu>

      {/* Project chat history sub-items */}
      <CollapseExpandMotion open={isExpanded} className="ml-5 border-l border-sidebar-border">
        <ProjectChatList projectId={project.id} />
      </CollapseExpandMotion>
    </div>
  )
})
