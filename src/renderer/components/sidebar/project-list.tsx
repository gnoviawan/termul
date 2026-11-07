import { LayoutGroup, Reorder } from 'framer-motion'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { ChevronDown, ChevronRight, FolderPlus } from '@/components/icons'
import { RailTooltip } from '@/components/shell/rail-button'
import { CollapseExpandMotion } from '@/components/ui/collapse-expand-motion'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project, ProjectGroup } from '@/types/project'
import { AddProjectMenu } from './add-project-menu'
import { ArchivedProjectItem } from './archived-project-item'
import type { ProjectRowStatus } from './indicators'
import { RailGroupRow } from './rail-group-row'
import { RailProjectItem } from './rail-project-item'
import { RAIL_SECTION_BUTTON_CLASS, RailSectionHeader } from './rail-section-header'
import { useDragLift } from './use-drag-lift'

export interface ProjectListProps {
  projects: Project[]
  activeProjectId: string

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
  editingId: string | null
  editName: string
  projectStatus: (projectId: string) => ProjectRowStatus
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
  onReorderProjects: (projectIds: string[]) => void

  // Archived section
  archivedProjects: Project[]
  showArchived: boolean
  setShowArchived: Dispatch<SetStateAction<boolean>>
  renderArchivedProjectContextMenu: (project: Project) => React.ReactNode

  /**
   * Label the grouped rows "Groups" and the ungrouped ones "Projects", each
   * with a `+`. Off when there is no group (the sidebar then keeps its own
   * Projects header above the list).
   */
  railSections?: boolean
  onNewProject?: () => void
  onNewGroup?: () => void
}

export function ProjectList({
  projects,
  activeProjectId,
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
  editingId,
  editName,
  projectStatus,
  setEditName,
  handleSaveRename,
  handleCancelRename,
  onRowContextMenu,
  renderProjectContextMenu,
  openNeedsYou,
  openProject,
  onReorderProjects,
  archivedProjects,
  showArchived,
  setShowArchived,
  renderArchivedProjectContextMenu,
  railSections = false,
  onNewProject,
  onNewGroup
}: ProjectListProps): React.JSX.Element {
  // One draggable active-project row, shared by grouped and ungrouped lists.
  // Dropping on a folder header or group container moves the project there.
  // The row also watches git for its diff stat.
  const showSections = railSections
  // The lifted row's shadow is a CSS transition keyed off data-dragging:
  // Motion can't interpolate a var() shadow, so whileDrag would snap it.
  // The lift (opaque bg) holds until the row lands, and `relative` lets
  // Reorder's own zIndex apply, so neighbours never show through it.
  const { liftedId, lift, release, settle } = useDragLift()
  const renderProjectRow = (project: Project): React.JSX.Element => {
    const shortcutIndex = activeIndexById.get(project.id) ?? -1
    return (
      <Reorder.Item
        key={project.id}
        value={project}
        drag="y"
        layout="position"
        data-dragging={liftedId === project.id || undefined}
        className="relative list-none rounded-lg transition-shadow duration-[110ms] ease-out motion-reduce:transition-none data-[dragging]:bg-sidebar data-[dragging]:shadow-md data-[dragging]:duration-150"
        whileDrag={{
          scale: 1.02,
          pointerEvents: 'none'
        }}
        onDragStart={() => lift(project.id)}
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
              // The row changes lists, so its snap-back (and settle) never runs.
              settle(project.id)
              moveProjectToGroup(project.id, nextGroupId)
            }
          }
          setActiveDragOverGroupId(null)
          activeDragOverGroupIdRef.current = null
          release(project.id)
        }}
        onDragTransitionEnd={() => settle(project.id)}
      >
        <RailProjectItem
          project={project}
          isActive={project.id === activeProjectId}
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
          onSettingsClick={() =>
            useSettingsModalStore.getState().openProject(undefined, project.id)
          }
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
      ) : (
        <div data-testid="active-projects-container">
          {/* LayoutGroup keeps Reorder layout measurements in sync when an item's
          own height changes (e.g. expanding/collapsing a project's chat list via the
          chevron). Without it, the group caches stale item boxes after a
          height change and drag-to-reorder stops working. */}
          <LayoutGroup>
            {showSections && (
              <RailSectionHeader label="Groups">
                <RailTooltip label="New group">
                  <button
                    type="button"
                    onClick={onNewGroup}
                    className={RAIL_SECTION_BUTTON_CLASS}
                    aria-label="New group"
                    data-testid="rail-new-group"
                  >
                    <FolderPlus size={14} />
                  </button>
                </RailTooltip>
              </RailSectionHeader>
            )}

            {/* Grouped Projects */}
            <Reorder.Group
              axis="y"
              values={visibleGroups}
              onReorder={(reordered) => {
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
                    drag="y"
                    layout="position"
                    className="list-none"
                  >
                    <div
                      className={cn(
                        'flex flex-col gap-0.5',
                        // Rail: an expanded group and its projects share one
                        // soft surface; the rows keep the shared icon column.
                        !isCollapsed && '-mx-1 rounded-lg bg-foreground/[0.03] px-1 pb-1'
                      )}
                      data-testid={`rail-group-${group.id}`}
                    >
                      {/* Folder Header */}
                      <RailGroupRow
                        group={group}
                        isCollapsed={Boolean(isCollapsed)}
                        isDragOver={activeDragOverGroupId === group.id}
                        isEditing={editingGroupId === group.id}
                        editName={editGroupName}
                        onEditNameChange={setEditGroupName}
                        onCommitRename={() => {
                          if (editGroupName.trim()) {
                            renameGroup(group.id, editGroupName.trim())
                          }
                          setEditingGroupId(null)
                        }}
                        onCancelRename={() => setEditingGroupId(null)}
                        onToggle={() => toggleGroupCollapse(group.id)}
                        onContextMenu={onRowContextMenu}
                        menu={renderGroupContextMenu(group)}
                      />

                      {/* Projects in Group */}
                      <CollapseExpandMotion open={!isCollapsed && gpProjects.length > 0}>
                        <Reorder.Group
                          axis="y"
                          values={gpProjects}
                          onReorder={(reordered) => {
                            reorderProjectInGroup(
                              group.id,
                              reordered.map((p) => p.id)
                            )
                          }}
                          className="flex flex-col gap-0.5"
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

            {/* Ungrouped Projects. The header stays even when every project is
                grouped: its + is how the next project gets added. */}
            {showSections && (
              <RailSectionHeader label="Projects" className="mt-1">
                <AddProjectMenu
                  onNewProject={() => onNewProject?.()}
                  onNewGroup={() => onNewGroup?.()}
                  buttonClassName={RAIL_SECTION_BUTTON_CLASS}
                />
              </RailSectionHeader>
            )}
            {ungroupedActiveProjects.length > 0 && (
              <Reorder.Group
                axis="y"
                values={ungroupedActiveProjects}
                onReorder={(reordered) => {
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
          {archivedProjects.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5">
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`label-panel flex h-8 w-full items-center gap-1.5 rounded-md pl-1 pr-1.5 transition-colors duration-150 ease-out hover:bg-foreground/[0.03] hover:text-foreground focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent ${FOCUS_RING_CLASS}`}
                aria-expanded={showArchived}
                aria-label={`Archived projects (${archivedProjects.length})`}
              >
                <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
                  {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                Archived ({archivedProjects.length})
              </button>
              {showArchived &&
                archivedProjects.map((project) => (
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
