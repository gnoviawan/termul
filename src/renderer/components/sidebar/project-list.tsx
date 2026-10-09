import { LayoutGroup, Reorder } from 'framer-motion'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@/components/icons'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project, ProjectGroup } from '@/types/project'
import { ArchivedProjectItem } from './archived-project-item'
import type { ProjectRowStatus } from './indicators'
import { ProjectItem } from './project-item'

export interface ProjectListProps {
  projects: Project[]
  activeProjectId: string
  isSearching: boolean
  trimmedQuery: string
  hasNoSearchResults: boolean

  // Groups
  groups: ProjectGroup[]
  visibleGroups: { group: ProjectGroup; projects: Project[] }[]
  activeDragOverGroupId: string | null
  activeDragOverGroupIdRef: MutableRefObject<string | null>
  setActiveDragOverGroupId: Dispatch<SetStateAction<string | null>>
  editingGroupId: string | null
  editGroupName: string
  setEditGroupName: Dispatch<SetStateAction<string>>
  setEditingGroupId: Dispatch<SetStateAction<string | null>>
  renameGroup: (id: string, newName: string) => void
  toggleGroupCollapse: (id: string) => void
  reorderGroups: (groupIds: string[]) => void
  reorderProjectInGroup: (groupId: string, projectIds: string[]) => void
  moveProjectToGroup: (projectId: string, targetGroupId: string | null) => void
  renderGroupContextMenu: (group: ProjectGroup) => React.ReactNode

  // Project rows
  ungroupedActiveProjects: Project[]
  activeIndexById: ReadonlyMap<string, number>
  expandedProjects: ReadonlySet<string>
  editingId: string | null
  editName: string
  projectStatus: (projectId: string) => ProjectRowStatus
  toggleProjectExpanded: (projectId: string) => void
  setEditName: Dispatch<SetStateAction<string>>
  handleSaveRename: (projectId: string) => void
  handleCancelRename: () => void
  /** Right-click on a project or group row (captures the pointer). */
  onRowContextMenu: (e: React.MouseEvent) => void
  renderProjectContextMenu: (project: Project) => React.ReactNode
  openNeedsYou: (projectId: string) => void
  /** Select the project and go to the workspace. */
  openProject: (projectId: string) => void
  /** Select the project without navigating (for the settings shortcut). */
  selectProject: (id: string) => void
  onReorderProjects: (projectIds: string[]) => void

  // Archived section
  filteredArchivedProjects: Project[]
  showArchived: boolean
  setShowArchived: Dispatch<SetStateAction<boolean>>
  renderArchivedProjectContextMenu: (project: Project) => React.ReactNode
}

export function ProjectList({
  projects,
  activeProjectId,
  isSearching,
  trimmedQuery,
  hasNoSearchResults,
  groups,
  visibleGroups,
  activeDragOverGroupId,
  activeDragOverGroupIdRef,
  setActiveDragOverGroupId,
  editingGroupId,
  editGroupName,
  setEditGroupName,
  setEditingGroupId,
  renameGroup,
  toggleGroupCollapse,
  reorderGroups,
  reorderProjectInGroup,
  moveProjectToGroup,
  renderGroupContextMenu,
  ungroupedActiveProjects,
  activeIndexById,
  expandedProjects,
  editingId,
  editName,
  projectStatus,
  toggleProjectExpanded,
  setEditName,
  handleSaveRename,
  handleCancelRename,
  onRowContextMenu,
  renderProjectContextMenu,
  openNeedsYou,
  openProject,
  selectProject,
  onReorderProjects,
  filteredArchivedProjects,
  showArchived,
  setShowArchived,
  renderArchivedProjectContextMenu
}: ProjectListProps): React.JSX.Element {
  // One draggable active-project row, shared by grouped and ungrouped lists.
  // Dropping on a folder header or group container moves the project there.
  const renderProjectRow = (project: Project): React.JSX.Element => {
    const shortcutIndex = activeIndexById.get(project.id) ?? -1
    return (
      <Reorder.Item
        key={project.id}
        value={project}
        drag={isSearching ? false : 'y'}
        layout="position"
        className="list-none"
        whileDrag={{
          scale: 1.02,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          pointerEvents: 'none'
        }}
        onDrag={(_event, info) => {
          const element = document.elementFromPoint(info.point.x, info.point.y)
          const container = element?.closest('[data-group-container-id]')
          const folderHeader = element?.closest('[data-group-id]')
          const groupId =
            container?.getAttribute('data-group-container-id') ||
            folderHeader?.getAttribute('data-group-id') ||
            null
          if (groupId !== activeDragOverGroupId) {
            setActiveDragOverGroupId(groupId)
            activeDragOverGroupIdRef.current = groupId
          }
        }}
        onDragEnd={() => {
          const targetGroupId = activeDragOverGroupIdRef.current
          if (targetGroupId) {
            const nextGroupId = targetGroupId === 'root' ? null : targetGroupId
            const currentGroup = groups.find((g) => g.projectIds.includes(project.id))
            const currentGroupId = currentGroup?.id ?? null
            if (nextGroupId !== currentGroupId) {
              moveProjectToGroup(project.id, nextGroupId)
            }
          }
          setActiveDragOverGroupId(null)
          activeDragOverGroupIdRef.current = null
        }}
      >
        <ProjectItem
          project={project}
          isActive={project.id === activeProjectId}
          isExpanded={expandedProjects.has(project.id)}
          onToggleExpand={() => toggleProjectExpanded(project.id)}
          isEditing={editingId === project.id}
          editName={editName}
          shortcut={
            shortcutIndex >= 0 && shortcutIndex < 9 ? `Ctrl+${shortcutIndex + 1}` : undefined
          }
          status={projectStatus(project.id)}
          onOpenNeedsYou={() => openNeedsYou(project.id)}
          onClick={() => openProject(project.id)}
          onContextMenu={onRowContextMenu}
          renderContextMenu={renderProjectContextMenu}
          onEditNameChange={setEditName}
          onSaveRename={() => handleSaveRename(project.id)}
          onCancelRename={handleCancelRename}
          onSettingsClick={() => {
            selectProject(project.id)
            useSettingsModalStore.getState().openProject()
          }}
        />
      </Reorder.Item>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-1" data-group-id="root">
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-6 text-center opacity-60">
          <p className="text-sm text-muted-foreground">No projects yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create your first project to get started
          </p>
        </div>
      ) : hasNoSearchResults ? (
        <div
          className="flex flex-col items-center justify-center p-6 text-center opacity-60"
          data-testid="project-search-empty"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm text-muted-foreground">No projects found</p>
          <p className="text-xs text-muted-foreground mt-1 break-words">
            Nothing matches “{trimmedQuery}”
          </p>
        </div>
      ) : (
        <div data-testid="active-projects-container">
          {/* LayoutGroup keeps Reorder layout measurements in sync when an item's
          own height changes (e.g. expanding/collapsing a project's chat list via the
          chevron). Without it, the group caches stale item boxes after a
          height change and drag-to-reorder stops working. */}
          <LayoutGroup>
            {/* Grouped Projects */}
            <Reorder.Group
              axis="y"
              values={visibleGroups}
              onReorder={(reordered) => {
                if (isSearching) return
                reorderGroups(reordered.map((gp) => gp.group.id))
              }}
              className="flex flex-col gap-0.5"
              data-testid="grouped-projects-container"
            >
              {visibleGroups.map((groupEntry) => {
                const { group, projects: gpProjects } = groupEntry
                const isCollapsed = group.isCollapsed
                return (
                  <Reorder.Item
                    key={group.id}
                    value={groupEntry}
                    drag={isSearching ? false : 'y'}
                    layout="position"
                    className="list-none"
                  >
                    <div className="flex flex-col gap-0.5">
                      {/* Folder Header */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            onClick={() => toggleGroupCollapse(group.id)}
                            onContextMenu={onRowContextMenu}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleGroupCollapse(group.id)
                              }
                            }}
                            className={cn(
                              'flex h-8 w-full cursor-pointer select-none items-center gap-1.5 rounded-md pl-1 pr-1.5 text-left text-xs',
                              'transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                              activeDragOverGroupId === group.id
                                ? 'bg-primary/10 ring-1 ring-inset ring-primary/60'
                                : 'hover:bg-foreground/[0.03]'
                            )}
                            data-group-id={group.id}
                          >
                            <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            </span>
                            <span
                              className={cn(
                                'inline-flex size-4 shrink-0 items-center justify-center',
                                group.color
                                  ? getColorClasses(group.color).text
                                  : 'text-muted-foreground'
                              )}
                            >
                              {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
                            </span>
                            {editingGroupId === group.id ? (
                              <input
                                type="text"
                                value={editGroupName}
                                onChange={(e) => setEditGroupName(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    if (editGroupName.trim()) {
                                      renameGroup(group.id, editGroupName.trim())
                                    }
                                    setEditingGroupId(null)
                                  } else if (e.key === 'Escape') {
                                    setEditingGroupId(null)
                                  }
                                }}
                                onBlur={() => {
                                  if (editGroupName.trim()) {
                                    renameGroup(group.id, editGroupName.trim())
                                  }
                                  setEditingGroupId(null)
                                }}
                                className="h-6 min-w-0 flex-1 rounded border border-ring bg-card px-1.5 text-xs text-foreground outline-none"
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {group.name}
                              </span>
                            )}
                            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                              {gpProjects.length}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        {renderGroupContextMenu(group)}
                      </ContextMenu>

                      {/* Projects in Group */}
                      <CollapseExpandMotion
                        open={(!isCollapsed || isSearching) && gpProjects.length > 0}
                      >
                        <Reorder.Group
                          axis="y"
                          values={gpProjects}
                          onReorder={(reordered) => {
                            if (isSearching) return
                            reorderProjectInGroup(
                              group.id,
                              reordered.map((p) => p.id)
                            )
                          }}
                          className="flex flex-col gap-0.5 pl-4"
                          data-group-container-id={group.id}
                        >
                          {gpProjects.map(renderProjectRow)}
                        </Reorder.Group>
                      </CollapseExpandMotion>
                    </div>
                  </Reorder.Item>
                )
              })}
            </Reorder.Group>

            {/* Ungrouped Projects */}
            {ungroupedActiveProjects.length > 0 && (
              <Reorder.Group
                axis="y"
                values={ungroupedActiveProjects}
                onReorder={(reordered) => {
                  if (isSearching) return
                  onReorderProjects(reordered.map((p) => p.id))
                }}
                className="mt-0.5 flex flex-col gap-0.5"
                data-testid="ungrouped-projects-container"
              >
                {ungroupedActiveProjects.map(renderProjectRow)}
              </Reorder.Group>
            )}
          </LayoutGroup>

          {/* Archived Projects Section */}
          {filteredArchivedProjects.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5">
              <button
                onClick={() => setShowArchived(!showArchived)}
                disabled={isSearching}
                className="label-panel flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                aria-expanded={showArchived || isSearching}
                aria-label={`Archived projects (${filteredArchivedProjects.length})`}
              >
                <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                  {showArchived || isSearching ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </span>
                Archived ({filteredArchivedProjects.length})
              </button>
              {(showArchived || isSearching) &&
                filteredArchivedProjects.map((project) => (
                  <ArchivedProjectItem
                    key={project.id}
                    project={project}
                    status={projectStatus(project.id)}
                    onOpenNeedsYou={() => openNeedsYou(project.id)}
                    onClick={() => openProject(project.id)}
                    onContextMenu={onRowContextMenu}
                    renderContextMenu={renderArchivedProjectContextMenu}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
