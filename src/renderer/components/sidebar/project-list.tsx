import { LayoutGroup, Reorder } from 'framer-motion'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project, ProjectGroup } from '@/types/project'
import { ArchivedProjectItem } from './archived-project-item'
import { ProjectItem } from './project-item'

export interface ProjectListProps {
  projects: Project[]
  activeProjectId: string
  isSearching: boolean
  trimmedQuery: string
  hasNoSearchResults: boolean
  onCreateProject: () => void
  onClearSearch: () => void

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
  handleGroupContextMenu: (e: React.MouseEvent) => void
  renderGroupContextMenu: (groupId: string) => React.ReactNode

  // Project rows
  ungroupedActiveProjects: Project[]
  activeIndexById: ReadonlyMap<string, number>
  expandedProjects: ReadonlySet<string>
  editingId: string | null
  editName: string
  projectErrorIds: ReadonlySet<string>
  attentionCounts: Record<string, number>
  runningProjectIds: ReadonlySet<string>
  projectHasActivity: (projectId: string) => boolean
  toggleProjectExpanded: (projectId: string) => void
  setEditName: Dispatch<SetStateAction<string>>
  handleSaveRename: (projectId: string) => void
  handleCancelRename: () => void
  handleContextMenu: (e: React.MouseEvent) => void
  renderProjectContextMenu: (project: Project) => React.ReactNode
  openNeedsYou: (projectId: string) => void
  selectProject: (id: string) => void
  onSelectProject: (id: string) => void
  onReorderProjects: (projectIds: string[]) => void
  navigate: NavigateFunction

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
  onCreateProject,
  onClearSearch,
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
  handleGroupContextMenu,
  renderGroupContextMenu,
  ungroupedActiveProjects,
  activeIndexById,
  expandedProjects,
  editingId,
  editName,
  projectErrorIds,
  attentionCounts,
  runningProjectIds,
  projectHasActivity,
  toggleProjectExpanded,
  setEditName,
  handleSaveRename,
  handleCancelRename,
  handleContextMenu,
  renderProjectContextMenu,
  openNeedsYou,
  selectProject,
  onSelectProject,
  onReorderProjects,
  navigate,
  filteredArchivedProjects,
  showArchived,
  setShowArchived,
  renderArchivedProjectContextMenu
}: ProjectListProps): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto py-1" data-group-id="root">
      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div>
            <p className="text-sm text-foreground">No projects yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Projects keep terminals, snapshots, and chats together.
            </p>
          </div>
          <Button type="button" size="sm" onClick={onCreateProject}>
            Create a project
          </Button>
        </div>
      ) : hasNoSearchResults ? (
        <div
          className="flex flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="project-search-empty"
          role="status"
          aria-live="polite"
        >
          <p className="break-words text-sm text-foreground">No results for “{trimmedQuery}”.</p>
          <Button type="button" variant="ghost" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
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
              className="flex flex-col gap-1"
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
                    <div className="flex flex-col">
                      {/* Folder Header */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            onClick={() => toggleGroupCollapse(group.id)}
                            onContextMenu={handleGroupContextMenu}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleGroupCollapse(group.id)
                              }
                            }}
                            className={cn(
                              'w-full flex items-center h-7 px-1.5 hover:bg-sidebar-accent/50 rounded transition-colors text-left cursor-pointer select-none',
                              activeDragOverGroupId === group.id &&
                                'bg-primary/20 border border-primary/50'
                            )}
                            data-group-id={group.id}
                          >
                            <span className="h-5 w-5 inline-flex items-center justify-center flex-shrink-0 mr-0.5">
                              {isCollapsed ? (
                                <ChevronRight size={12} className="text-muted-foreground" />
                              ) : (
                                <ChevronDown size={12} className="text-muted-foreground" />
                              )}
                            </span>
                            <span
                              className={cn(
                                'mr-1.5 flex-shrink-0 inline-flex items-center',
                                group.color ? getColorClasses(group.color).text : 'text-primary/80'
                              )}
                            >
                              {isCollapsed ? <Folder size={13} /> : <FolderOpen size={13} />}
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
                                className="flex-1 min-w-0 bg-sidebar-accent border border-border rounded px-1 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary mr-2"
                                onClick={(e) => e.stopPropagation()}
                              />
                            ) : (
                              <span className="text-sm font-medium text-sidebar-foreground truncate flex-1">
                                {group.name}
                              </span>
                            )}
                            <span className="text-xs text-muted-foreground/60 px-2 font-normal">
                              {gpProjects.length}
                            </span>
                          </div>
                        </ContextMenuTrigger>
                        {renderGroupContextMenu(group.id)}
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
                          className="pl-4 flex flex-col"
                          data-group-container-id={group.id}
                        >
                          {gpProjects.map((project) => {
                            const hasActivity = projectHasActivity(project.id)
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
                                  const element = document.elementFromPoint(
                                    info.point.x,
                                    info.point.y
                                  )
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
                                    const nextGroupId =
                                      targetGroupId === 'root' ? null : targetGroupId
                                    const currentGroup = groups.find((g) =>
                                      g.projectIds.includes(project.id)
                                    )
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
                                    shortcutIndex >= 0 && shortcutIndex < 9
                                      ? `Ctrl+${shortcutIndex + 1}`
                                      : undefined
                                  }
                                  hasActivity={hasActivity}
                                  hasError={projectErrorIds.has(project.id)}
                                  attentionCount={attentionCounts[project.id] ?? 0}
                                  running={runningProjectIds.has(project.id)}
                                  onOpenNeedsYou={() => openNeedsYou(project.id)}
                                  onClick={() => {
                                    onSelectProject(project.id)
                                    navigate('/')
                                  }}
                                  onContextMenu={handleContextMenu}
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
                          })}
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
                className="flex flex-col mt-1"
                data-testid="ungrouped-projects-container"
              >
                {ungroupedActiveProjects.map((project) => {
                  const hasActivity = projectHasActivity(project.id)
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
                          shortcutIndex >= 0 && shortcutIndex < 9
                            ? `Ctrl+${shortcutIndex + 1}`
                            : undefined
                        }
                        hasActivity={hasActivity}
                        hasError={projectErrorIds.has(project.id)}
                        attentionCount={attentionCounts[project.id] ?? 0}
                        running={runningProjectIds.has(project.id)}
                        onOpenNeedsYou={() => openNeedsYou(project.id)}
                        onClick={() => {
                          onSelectProject(project.id)
                          navigate('/')
                        }}
                        onContextMenu={handleContextMenu}
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
                })}
              </Reorder.Group>
            )}
          </LayoutGroup>

          {/* Archived Projects Section */}
          {filteredArchivedProjects.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowArchived(!showArchived)}
                disabled={isSearching}
                className="label-section w-full flex items-center px-3 py-1.5 text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:hover:bg-transparent"
                aria-expanded={showArchived || isSearching}
                aria-label={`Archived projects (${filteredArchivedProjects.length})`}
              >
                {showArchived || isSearching ? (
                  <ChevronDown size={14} className="mr-2" />
                ) : (
                  <ChevronRight size={14} className="mr-2" />
                )}
                Archived ({filteredArchivedProjects.length})
              </button>
              {(showArchived || isSearching) &&
                filteredArchivedProjects.map((project) => {
                  const hasActivity = projectHasActivity(project.id)
                  return (
                    <ArchivedProjectItem
                      key={project.id}
                      project={project}
                      hasActivity={hasActivity}
                      hasError={projectErrorIds.has(project.id)}
                      attentionCount={attentionCounts[project.id] ?? 0}
                      running={runningProjectIds.has(project.id)}
                      onOpenNeedsYou={() => openNeedsYou(project.id)}
                      onClick={() => {
                        onSelectProject(project.id)
                        navigate('/')
                      }}
                      onContextMenu={handleContextMenu}
                      renderContextMenu={renderArchivedProjectContextMenu}
                    />
                  )
                })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
