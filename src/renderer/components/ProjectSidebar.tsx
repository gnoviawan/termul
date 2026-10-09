import type { DetectedShells } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderPlus, Plus } from '@/components/icons'
import { SidebarToggleButton } from '@/components/TitlebarPanelToggles'
import { PANEL_HEADER_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { toast } from '@/hooks/use-toast'
import { useWorktreeReconciler } from '@/hooks/use-worktree-reconciler'
import { dialogApi, shellApi } from '@/lib/api'
import { filterProjects, shouldShowProjectSearch } from '@/lib/project-filter'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useProjectsWithActiveAgentChat } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectActions, useProjectStore } from '@/stores/project-store'
import { useProjectsWithActivity, useProjectsWithErrors } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project, ProjectColor, ProjectGroup } from '@/types/project'
import { ColorPickerPopover } from './ColorPickerPopover'
import { ConfirmDialog } from './ConfirmDialog'
import { NewGroupModal } from './NewGroupModal'
import { NewWorktreeModal } from './NewWorktreeModal'
import { GroupContextMenuContent } from './sidebar/group-context-menu'
import { type ProjectRowStatus, resolveProjectLiveState } from './sidebar/indicators'
import {
  ArchivedProjectContextMenuContent,
  ProjectContextMenuContent
} from './sidebar/project-context-menu'
import { ProjectList } from './sidebar/project-list'
import { ProjectSettingsDialog } from './sidebar/project-settings-dialog'
import { SidebarFooter } from './sidebar/sidebar-footer'
import { SidebarSearchField } from './sidebar/sidebar-search-field'
import { SSHResizableSection } from './sidebar/ssh-section'
import type { ColorPickerState, ProjectSidebarProps } from './sidebar/types'

/** Projects header icon button: the panel button plus a 14px glyph. */
const HEADER_ICON_BUTTON = `${PANEL_ICON_BUTTON_CLASS} cursor-pointer [&_svg]:size-3.5`

export function ProjectSidebar({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onUpdateProject,
  onDeleteProject,
  onArchiveProject,
  onRestoreProject,
  onReorderProjects,
  onSSHConnect,
  onSelectSSHProfile,
  activeSSHProfileId
}: ProjectSidebarProps): React.JSX.Element {
  const navigate = useNavigate()
  const {
    selectProject,
    addProject,
    addGroup,
    removeGroup,
    renameGroup,
    toggleGroupCollapse,
    moveProjectToGroup,
    reorderGroups,
    reorderProjectInGroup,
    updateGroup
  } = useProjectActions()
  const storeGroups = useProjectStore((state) => state.groups)
  const groups = useMemo(() => storeGroups ?? [], [storeGroups])

  // Reconcile stored worktrees against actual git state (detects orphaned entries)
  useWorktreeReconciler(activeProjectId)

  // Show archived toggle state
  const [showArchived, setShowArchived] = useState(false)

  // Group management states
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editGroupName, setEditGroupName] = useState('')
  // Open when non-null; `projectIdToMove` moves that project into the new group.
  const [newGroupModal, setNewGroupModal] = useState<{ projectIdToMove?: string } | null>(null)
  const [groupDeleteConfirm, setGroupDeleteConfirm] = useState<{
    group: ProjectGroup
    deleteProjects: boolean
  } | null>(null)

  // Last right-click coordinates, captured so the `ColorPickerPopover` (a
  // Popover, not a Radix context menu) can open near the pointer after a
  // "Change Color" menu item is selected. The Radix `<ContextMenuTrigger>`
  // wrapping each row owns menu open/positioning.
  const contextMenuPosRef = useRef({ x: 0, y: 0 })

  const [activeDragOverGroupId, setActiveDragOverGroupId] = useState<string | null>(null)
  const activeDragOverGroupIdRef = useRef<string | null>(null)

  // Project search/filter query
  const [searchQuery, setSearchQuery] = useState('')

  // Expanded projects — expansion is controlled solely by the chevron.
  // Selecting a project does not auto-expand its chat list, keeping the list uncluttered.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set<string>())

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // Dialog targets: each dialog is open while its target is non-null.
  const [colorPicker, setColorPicker] = useState<ColorPickerState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null)
  const [worktreeProjectId, setWorktreeProjectId] = useState<string | null>(null)

  const handleOpenColorPicker = useCallback(
    (targetId: string, targetType: 'project' | 'group'): void => {
      setColorPicker({ ...contextMenuPosRef.current, targetId, targetType })
    },
    []
  )

  const closeColorPicker = useCallback((): void => {
    setColorPicker(null)
  }, [])

  const handleColorChange = useCallback(
    (color: ProjectColor): void => {
      if (!colorPicker) return
      if (colorPicker.targetType === 'project') {
        onUpdateProject(colorPicker.targetId, { color })
      } else {
        updateGroup(colorPicker.targetId, { color })
      }
    },
    [colorPicker, onUpdateProject, updateGroup]
  )

  // Available shells state
  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)

  // Fetch available shells on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success) {
          setAvailableShells(result.data)
        }
      } catch {
        // Ignore errors
      }
    }
    void fetchShells()
  }, [])

  // Optimized subscription: only re-render sidebar if which projects have activity changes.
  // This prevents re-renders when terminal text output changes.
  const [projectActivityIds, projectErrorIds] = [useProjectsWithActivity(), useProjectsWithErrors()]
  const agentChatActivityIds = useProjectsWithActiveAgentChat()
  const { attentionCounts, firstNeedsYouSessionId, runningProjectIds } =
    useAgentChatProjectSignals()

  const openProject = useCallback(
    (projectId: string) => {
      onSelectProject(projectId)
      navigate('/')
    },
    [navigate, onSelectProject]
  )
  const openNeedsYou = useCallback(
    (projectId: string) => {
      const sessionId = firstNeedsYouSessionId[projectId]
      if (sessionId && projectId === activeProjectId) {
        useWorkspaceStore.getState().addAgentChatTab(sessionId)
        return
      }
      if (sessionId) {
        useAgentChatLifetimeStore.getState().requestFocus(projectId, sessionId)
      }
      openProject(projectId)
    },
    [activeProjectId, firstNeedsYouSessionId, openProject]
  )
  const projectStatus = useCallback(
    (projectId: string): ProjectRowStatus => ({
      live: resolveProjectLiveState(
        projectActivityIds.includes(projectId) || agentChatActivityIds.includes(projectId),
        runningProjectIds.has(projectId)
      ),
      attentionCount: attentionCounts[projectId] ?? 0,
      crashed: projectErrorIds.has(projectId)
    }),
    [projectActivityIds, agentChatActivityIds, runningProjectIds, attentionCounts, projectErrorIds]
  )

  const toggleProjectExpanded = useCallback((projectId: string): void => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  const handleCreateGroupSubmit = useCallback(
    (name: string) => {
      const newGroupId = addGroup(name)
      if (newGroupModal?.projectIdToMove) {
        moveProjectToGroup(newGroupModal.projectIdToMove, newGroupId)
      }
    },
    [addGroup, moveProjectToGroup, newGroupModal]
  )

  const handleAddNewProjectToGroup = useCallback(
    async (groupId: string) => {
      try {
        const result = await dialogApi.selectDirectory()
        if (result.success && result.data) {
          const projectPath = result.data
          const folderName = projectPath.split(/[\\/]/).pop() || 'New Project'
          const newProject = addProject(folderName, 'blue', projectPath)
          moveProjectToGroup(newProject.id, groupId)
          toast({
            title: 'Project created',
            description: `Created project "${folderName}" and added to group.`
          })
        }
      } catch (err) {
        console.error('Failed to create project:', err)
        toast({
          title: 'Error',
          description: 'Failed to create project from folder.',
          variant: 'destructive'
        })
      }
    },
    [addProject, moveProjectToGroup]
  )

  // Shared by project and group rows.
  const handleRowContextMenu = useCallback((e: React.MouseEvent): void => {
    // F1: no preventDefault() — Radix's `<ContextMenuTrigger asChild>` composes
    // this handler ahead of its own handleOpen (checkForDefaultPrevented: true);
    // a preventDefault here would make Radix skip opening the menu. Radix's
    // own handleContextMenu already suppresses the native menu.
    e.stopPropagation()
    // Capture the pointer for the ColorPickerPopover.
    contextMenuPosRef.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleStartRenameGroup = useCallback((group: ProjectGroup): void => {
    setEditingGroupId(group.id)
    setEditGroupName(group.name)
  }, [])

  const handleConfirmDeleteGroup = useCallback(
    (group: ProjectGroup, deleteProjects: boolean): void => {
      setGroupDeleteConfirm({ group, deleteProjects })
    },
    []
  )

  const handleDeleteGroup = useCallback((): void => {
    if (groupDeleteConfirm) {
      removeGroup(groupDeleteConfirm.group.id, groupDeleteConfirm.deleteProjects)
    }
    setGroupDeleteConfirm(null)
  }, [groupDeleteConfirm, removeGroup])

  // Split active and archived projects
  const activeProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])
  const archivedProjects = useMemo(() => projects.filter((p) => p.isArchived), [projects])

  const renderGroupContextMenu = useCallback(
    (group: ProjectGroup): React.ReactNode => (
      <GroupContextMenuContent
        group={group}
        activeProjects={activeProjects}
        onStartRename={handleStartRenameGroup}
        onOpenColorPicker={handleOpenColorPicker}
        moveProjectToGroup={moveProjectToGroup}
        onImportProject={(groupId) => void handleAddNewProjectToGroup(groupId)}
        onConfirmDelete={handleConfirmDeleteGroup}
      />
    ),
    [
      activeProjects,
      handleStartRenameGroup,
      handleOpenColorPicker,
      moveProjectToGroup,
      handleAddNewProjectToGroup,
      handleConfirmDeleteGroup
    ]
  )

  const handleStartRename = useCallback((project: Project): void => {
    setEditingId(project.id)
    setEditName(project.name)
  }, [])

  const handleSaveRename = useCallback(
    (projectId: string): void => {
      if (editName.trim()) {
        onUpdateProject(projectId, { name: editName.trim() })
      }
      setEditingId(null)
      setEditName('')
    },
    [editName, onUpdateProject]
  )

  const handleCancelRename = useCallback((): void => {
    setEditingId(null)
    setEditName('')
  }, [])

  const handleDelete = useCallback((): void => {
    if (deleteTarget) {
      onDeleteProject(deleteTarget.id)
    }
    setDeleteTarget(null)
  }, [deleteTarget, onDeleteProject])

  const renderProjectContextMenu = useCallback(
    (project: Project): React.ReactNode => (
      <ProjectContextMenuContent
        project={project}
        groups={groups}
        availableShells={availableShells}
        selectProject={selectProject}
        onStartRename={handleStartRename}
        onOpenSettings={setSettingsProjectId}
        onOpenColorPicker={handleOpenColorPicker}
        onUpdateProject={onUpdateProject}
        moveProjectToGroup={moveProjectToGroup}
        onCreateGroupForProject={(projectId) => setNewGroupModal({ projectIdToMove: projectId })}
        onNewWorktree={setWorktreeProjectId}
        onArchiveProject={onArchiveProject}
        onConfirmDelete={setDeleteTarget}
      />
    ),
    [
      availableShells,
      handleStartRename,
      handleOpenColorPicker,
      onUpdateProject,
      onArchiveProject,
      selectProject,
      groups,
      moveProjectToGroup
    ]
  )

  const renderArchivedProjectContextMenu = useCallback(
    (project: Project): React.ReactNode => (
      <ArchivedProjectContextMenuContent
        project={project}
        onRestoreProject={onRestoreProject}
        onConfirmDelete={setDeleteTarget}
      />
    ),
    [onRestoreProject]
  )

  const colorPickerTarget =
    colorPicker?.targetType === 'project'
      ? projects.find((p) => p.id === colorPicker.targetId)
      : groups.find((g) => g.id === colorPicker?.targetId)

  // The search box only renders once the list is long enough to be worth filtering.
  const showSearch = shouldShowProjectSearch(projects.length)

  // Apply the search query to each group. Filtering is gated on `showSearch` so a
  // lingering query can never keep the list filtered after the search box unmounts
  // (e.g. project count drops below the threshold). The unfiltered `activeProjects`
  // is kept for shortcut-index math below.
  const trimmedQuery = showSearch ? searchQuery.trim() : ''
  const isSearching = trimmedQuery.length > 0
  const filteredActiveProjects = useMemo(
    () => filterProjects(activeProjects, { searchQuery: trimmedQuery }),
    [activeProjects, trimmedQuery]
  )
  const filteredArchivedProjects = useMemo(
    () => filterProjects(archivedProjects, { searchQuery: trimmedQuery }),
    [archivedProjects, trimmedQuery]
  )

  // Map each active project id to its position in the UNFILTERED active list.
  // The badge reflects this position (not the filtered render index) so the
  // number a user sees doesn't shift around as they type a search query.
  const activeIndexById = useMemo(() => {
    const map = new Map<string, number>()
    activeProjects.forEach((p, i) => {
      map.set(p.id, i)
    })
    return map
  }, [activeProjects])

  // Group mapping for rendering
  const groupedProjectIds = useMemo(() => {
    const ids = new Set<string>()
    groups.forEach((g) => {
      g.projectIds.forEach((pid) => {
        ids.add(pid)
      })
    })
    return ids
  }, [groups])

  const groupProjectsMap = useMemo(() => {
    return groups.map((g) => {
      const projectsInGroup = g.projectIds
        .map((pid) => filteredActiveProjects.find((p) => p.id === pid))
        .filter((p): p is Project => p !== undefined)
      return {
        group: g,
        projects: projectsInGroup
      }
    })
  }, [groups, filteredActiveProjects])

  const ungroupedActiveProjects = useMemo(() => {
    return filteredActiveProjects.filter((p) => !groupedProjectIds.has(p.id))
  }, [filteredActiveProjects, groupedProjectIds])

  const visibleGroups = useMemo(() => {
    return groupProjectsMap.filter((gp) => gp.projects.length > 0 || !isSearching)
  }, [groupProjectsMap, isSearching])

  // Reset a lingering query if the search box is no longer shown.
  useEffect(() => {
    if (!showSearch && searchQuery) setSearchQuery('')
  }, [showSearch, searchQuery])

  // When the active project CHANGES to one that the current query hides (e.g. a
  // project was just created, or a Ctrl+1..9 shortcut selected a hidden project),
  // clear the search so the now-active project becomes visible instead of silently
  // vanishing. Keyed on a change of `activeProjectId` only — searching for OTHER
  // projects while the active one stays put must NOT wipe the query.
  const prevActiveProjectId = useRef(activeProjectId)
  useEffect(() => {
    const changed = prevActiveProjectId.current !== activeProjectId
    prevActiveProjectId.current = activeProjectId
    if (!changed || !isSearching || !activeProjectId) return
    const visible =
      filteredActiveProjects.some((p) => p.id === activeProjectId) ||
      filteredArchivedProjects.some((p) => p.id === activeProjectId)
    if (!visible) setSearchQuery('')
  }, [activeProjectId, isSearching, filteredActiveProjects, filteredArchivedProjects])
  const hasNoSearchResults =
    isSearching && filteredActiveProjects.length === 0 && filteredArchivedProjects.length === 0

  return (
    <aside className="w-64 bg-background flex flex-col flex-shrink-0 rounded-xl h-full">
      {/* Header with inline + button */}
      <div className={PANEL_HEADER_CLASS}>
        <span className="label-panel">Projects</span>
        <div className="flex items-center">
          {!isTauriContext() && <SidebarToggleButton className={HEADER_ICON_BUTTON} />}
          <button
            onClick={() => setNewGroupModal({})}
            className={HEADER_ICON_BUTTON}
            title="New Group Folder"
            aria-label="Create new group folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={onNewProject}
            className={HEADER_ICON_BUTTON}
            title="New Project"
            aria-label="Create new project from header"
            data-testid="header-new-project"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Project search — shared sidebar field */}
      {showSearch && (
        <div className="shrink-0 px-2 pb-2">
          <SidebarSearchField
            size="md"
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search projects…"
            ariaLabel="Search projects"
            clearLabel="Clear project search"
            testIdPrefix="project-search"
          />
        </div>
      )}

      {/* Project List */}
      <ProjectList
        projects={projects}
        activeProjectId={activeProjectId}
        isSearching={isSearching}
        trimmedQuery={trimmedQuery}
        hasNoSearchResults={hasNoSearchResults}
        groups={groups}
        visibleGroups={visibleGroups}
        activeDragOverGroupId={activeDragOverGroupId}
        activeDragOverGroupIdRef={activeDragOverGroupIdRef}
        setActiveDragOverGroupId={setActiveDragOverGroupId}
        editingGroupId={editingGroupId}
        editGroupName={editGroupName}
        setEditGroupName={setEditGroupName}
        setEditingGroupId={setEditingGroupId}
        renameGroup={renameGroup}
        toggleGroupCollapse={toggleGroupCollapse}
        reorderGroups={reorderGroups}
        reorderProjectInGroup={reorderProjectInGroup}
        moveProjectToGroup={moveProjectToGroup}
        renderGroupContextMenu={renderGroupContextMenu}
        ungroupedActiveProjects={ungroupedActiveProjects}
        activeIndexById={activeIndexById}
        expandedProjects={expandedProjects}
        editingId={editingId}
        editName={editName}
        projectStatus={projectStatus}
        toggleProjectExpanded={toggleProjectExpanded}
        setEditName={setEditName}
        handleSaveRename={handleSaveRename}
        handleCancelRename={handleCancelRename}
        onRowContextMenu={handleRowContextMenu}
        renderProjectContextMenu={renderProjectContextMenu}
        openNeedsYou={openNeedsYou}
        openProject={openProject}
        selectProject={selectProject}
        onReorderProjects={onReorderProjects}
        filteredArchivedProjects={filteredArchivedProjects}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        renderArchivedProjectContextMenu={renderArchivedProjectContextMenu}
      />

      {/* SSH Connections - Resizable */}
      <SSHResizableSection
        onSSHConnect={onSSHConnect}
        onSelectProfile={onSelectSSHProfile}
        activeProfileId={activeSSHProfileId}
      />

      {/* Version + update chip - pinned bottom */}
      <SidebarFooter />

      {/* Group Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={groupDeleteConfirm !== null}
        title="Delete Group Folder"
        message={
          groupDeleteConfirm?.deleteProjects
            ? `Are you sure you want to delete the group folder "${groupDeleteConfirm.group.name}" and all projects inside it? This action cannot be undone.`
            : `Are you sure you want to delete the group folder "${groupDeleteConfirm?.group.name ?? ''}"? Projects inside this group will be moved to the root folder list.`
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteGroup}
        onCancel={() => setGroupDeleteConfirm(null)}
      />

      {/* Color Picker Popover */}
      {colorPicker && colorPickerTarget && (
        <ColorPickerPopover
          x={colorPicker.x}
          y={colorPicker.y}
          currentColor={colorPickerTarget.color || 'blue'}
          onSelectColor={handleColorChange}
          onClose={closeColorPicker}
        />
      )}

      {/* Project Settings Dialog */}
      <ProjectSettingsDialog
        projectId={settingsProjectId}
        projects={projects}
        availableShells={availableShells}
        onUpdateProject={onUpdateProject}
        onClose={() => setSettingsProjectId(null)}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Project"
        message={`Are you sure you want to delete "${deleteTarget?.name ?? ''}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* New Worktree Modal */}
      <NewWorktreeModal
        isOpen={worktreeProjectId !== null}
        onClose={() => setWorktreeProjectId(null)}
        projectId={worktreeProjectId ?? ''}
      />

      {/* New Group Modal */}
      <NewGroupModal
        isOpen={newGroupModal !== null}
        onClose={() => setNewGroupModal(null)}
        onSubmit={handleCreateGroupSubmit}
      />
    </aside>
  )
}
