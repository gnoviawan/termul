import type { DetectedShells } from '@shared/types/ipc.types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PANEL_HEADER_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { toast } from '@/hooks/use-toast'
import { dialogApi, shellApi } from '@/lib/api'
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
import { AddProjectMenu } from './sidebar/add-project-menu'
import { GroupContextMenuContent } from './sidebar/group-context-menu'
import { type ProjectRowStatus, resolveProjectLiveState } from './sidebar/indicators'
import {
  ArchivedProjectContextMenuContent,
  ProjectContextMenuContent
} from './sidebar/project-context-menu'
import { ProjectList } from './sidebar/project-list'
import { ProjectSettingsDialog } from './sidebar/project-settings-dialog'
import { SSHResizableSection } from './sidebar/ssh-section'
import type { ColorPickerState, ProjectSidebarProps } from './sidebar/types'

/** Projects header icon button: the panel button plus a 14px glyph. */
const HEADER_ICON_BUTTON = `${PANEL_ICON_BUTTON_CLASS} cursor-pointer [&_svg]:size-3.5`

/**
 * The shell Rail's Projects section: header with one `+` menu, search, the
 * project list (diff stat on each row, no chat lists) and the SSH section. The
 * Rail container runs the worktree reconciler itself so it keeps running while
 * collapsed, and owns the footer.
 */
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
          const newProject = await addProject(folderName, 'blue', projectPath)
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
          description: `Failed to create project from folder: ${err instanceof Error ? err.message : String(err)}`,
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
        .map((pid) => activeProjects.find((p) => p.id === pid))
        .filter((p): p is Project => p !== undefined)
      return {
        group: g,
        projects: projectsInGroup
      }
    })
  }, [groups, activeProjects])

  const ungroupedActiveProjects = useMemo(() => {
    return activeProjects.filter((p) => !groupedProjectIds.has(p.id))
  }, [activeProjects, groupedProjectIds])

  const visibleGroups = groupProjectsMap

  // With groups, "Groups" and "Projects" headers sit inside the list, so the
  // sidebar's own Projects header steps aside. With no group (or nothing to
  // list) it stays, and so does its + menu, the path to the first group.
  const railSections = visibleGroups.length > 0 && projects.length > 0

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-background">
      {/* Header with inline + button */}
      {!railSections && (
        <div className={PANEL_HEADER_CLASS}>
          <span className="label-panel">Projects</span>
          <div className="flex items-center">
            <AddProjectMenu
              onNewProject={onNewProject}
              onNewGroup={() => setNewGroupModal({})}
              buttonClassName={HEADER_ICON_BUTTON}
            />
          </div>
        </div>
      )}

      {/* Project List */}
      <ProjectList
        projects={projects}
        activeProjectId={activeProjectId}
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
        editingId={editingId}
        editName={editName}
        projectStatus={projectStatus}
        setEditName={setEditName}
        handleSaveRename={handleSaveRename}
        handleCancelRename={handleCancelRename}
        onRowContextMenu={handleRowContextMenu}
        renderProjectContextMenu={renderProjectContextMenu}
        openNeedsYou={openNeedsYou}
        openProject={openProject}
        selectProject={selectProject}
        onReorderProjects={onReorderProjects}
        archivedProjects={archivedProjects}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        renderArchivedProjectContextMenu={renderArchivedProjectContextMenu}
        railSections={railSections}
        onNewProject={onNewProject}
        onNewGroup={() => setNewGroupModal({})}
      />

      {/* SSH Connections - Resizable */}
      <SSHResizableSection
        onSSHConnect={onSSHConnect}
        onSelectProfile={onSelectSSHProfile}
        activeProfileId={activeSSHProfileId}
      />

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
    </div>
  )
}
