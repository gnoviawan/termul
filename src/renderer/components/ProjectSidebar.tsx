import { useState, useCallback, useRef, useEffect, KeyboardEvent } from 'react'
import { Reorder } from 'framer-motion'
import {
  Plus,
  FolderOpen,
  Upload,
  Archive,
  Settings,
  Camera,
  Terminal,
  Edit2,
  Palette,
  Trash2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  GitBranch
} from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { Project, ProjectColor } from '@/types/project'
import type { DetectedShells } from '@shared/types/ipc.types'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem, ContextMenuSubItem } from './ContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { ColorPickerPopover } from './ColorPickerPopover'
import { WorktreeProjectSection, WorktreeCreateDialog } from '@/src/features/worktrees/components'

interface ContextMenuState {
  isOpen: boolean
  x: number
  y: number
  projectId: string
}

interface ColorPickerState {
  isOpen: boolean
  x: number
  y: number
  projectId: string
}

interface DeleteConfirmState {
  isOpen: boolean
  projectId: string
  projectName: string
}

interface WorktreeCreateDialogState {
  isOpen: boolean
  projectId: string
  projectName?: string
  projectPath?: string
}

interface ProjectSidebarProps {
  projects: Project[]
  activeProjectId: string
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onUpdateProject: (id: string, updates: Partial<Project>) => void
  onDeleteProject: (id: string) => void
  onArchiveProject: (id: string) => void
  onRestoreProject: (id: string) => void
  onReorderProjects: (projectIds: string[]) => void
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onUpdateProject,
  onDeleteProject,
  onArchiveProject,
  onRestoreProject,
  onReorderProjects
}: ProjectSidebarProps): React.JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()

  // Show archived toggle state
  const [showArchived, setShowArchived] = useState(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    projectId: ''
  })

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  // Color picker state
  const [colorPicker, setColorPicker] = useState<ColorPickerState>({
    isOpen: false,
    x: 0,
    y: 0,
    projectId: ''
  })

  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    projectId: '',
    projectName: ''
  })

  // Worktree create dialog state
  const [worktreeCreateDialog, setWorktreeCreateDialog] = useState<WorktreeCreateDialogState>({
    isOpen: false,
    projectId: '',
    projectName: ''
  })
  const [isWorktreeCreating, setIsWorktreeCreating] = useState(false)

  // Available shells state
  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)

  // Fetch available shells on mount
  useEffect(() => {
    const fetchShells = async () => {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success) {
          setAvailableShells(result.data)
        }
      } catch {
        // Ignore errors
      }
    }
    fetchShells()
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, projectId: string): void => {
    e.preventDefault()
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      projectId
    })
  }, [])

  const closeContextMenu = useCallback((): void => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleStartRename = useCallback(
    (projectId: string): void => {
      const project = projects.find((p) => p.id === projectId)
      if (project) {
        setEditingId(projectId)
        setEditName(project.name)
      }
    },
    [projects]
  )

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

  const handleOpenColorPicker = useCallback((projectId: string, x: number, y: number): void => {
    setColorPicker({
      isOpen: true,
      x,
      y,
      projectId
    })
  }, [])

  const closeColorPicker = useCallback((): void => {
    setColorPicker((prev) => ({ ...prev, isOpen: false }))
  }, [])

  const handleColorChange = useCallback(
    (color: ProjectColor): void => {
      if (colorPicker.projectId) {
        onUpdateProject(colorPicker.projectId, { color })
      }
    },
    [colorPicker.projectId, onUpdateProject]
  )

  const handleConfirmDelete = useCallback(
    (projectId: string): void => {
      const project = projects.find((p) => p.id === projectId)
      if (project) {
        setDeleteConfirm({
          isOpen: true,
          projectId,
          projectName: project.name
        })
      }
    },
    [projects]
  )

  const handleDelete = useCallback((): void => {
    if (deleteConfirm.projectId) {
      onDeleteProject(deleteConfirm.projectId)
    }
    setDeleteConfirm({ isOpen: false, projectId: '', projectName: '' })
  }, [deleteConfirm.projectId, onDeleteProject])

  const handleCancelDelete = useCallback((): void => {
    setDeleteConfirm({ isOpen: false, projectId: '', projectName: '' })
  }, [])

  const handleOpenWorktreeCreateDialog = useCallback((projectId: string): void => {
    const project = projects.find((p) => p.id === projectId)
    // Validate project exists and has path before opening dialog
    if (!project) {
      console.error('[ProjectSidebar] Cannot open worktree dialog: project not found', projectId)
      return
    }
    if (!project.path) {
      console.error('[ProjectSidebar] Cannot open worktree dialog: project has no path', projectId)
      return
    }
    setWorktreeCreateDialog({
      isOpen: true,
      projectId,
      projectName: project.name,
      projectPath: project.path
    })
  }, [projects])

  const handleWorktreeCreated = useCallback((worktreeId: string): void => {
    // Refresh worktrees for this project and expand the section
    // Note: The WorktreeProjectSection component listens to IPC events and will update
    // However, we proactively load to ensure UI is in sync
    console.log('[ProjectSidebar] Worktree created:', worktreeId, '- expanding project section')
    // The worktree store will auto-update via IPC event listeners in WorktreeProjectSection
    // No additional action needed here as the event-driven architecture handles refresh
  }, [])

  const getContextMenuItems = useCallback(
    (projectId: string): ContextMenuItem[] => {
      const project = projects.find((p) => p.id === projectId)
      const shellSubmenu: ContextMenuSubItem[] = availableShells?.available.map((shell) => ({
        label: shell.displayName,
        value: shell.name,
        isSelected: project?.defaultShell === shell.name
      })) || []

      const items: ContextMenuItem[] = [
        {
          label: 'Rename',
          icon: <Edit2 size={14} />,
          onClick: () => handleStartRename(projectId)
        },
        {
          label: 'Change Color',
          icon: <Palette size={14} />,
          onClick: () => handleOpenColorPicker(projectId, contextMenu.x, contextMenu.y)
        },
        {
          label: 'Create Worktree',
          icon: <GitBranch size={14} />,
          onClick: () => handleOpenWorktreeCreateDialog(projectId),
          disabled: isWorktreeCreating
        }
      ]

      if (shellSubmenu.length > 0) {
        items.push({
          label: 'Set Default Shell',
          icon: <Terminal size={14} />,
          submenu: shellSubmenu,
          onSubmenuSelect: (shellName: string) => {
            onUpdateProject(projectId, { defaultShell: shellName })
          }
        })
      }

      items.push(
        {
          label: 'Archive',
          icon: <Archive size={14} />,
          onClick: () => onArchiveProject(projectId)
        },
        {
          label: 'Delete',
          icon: <Trash2 size={14} />,
          onClick: () => handleConfirmDelete(projectId),
          variant: 'danger'
        }
      )

      return items
    },
    [projects, availableShells, contextMenu.x, contextMenu.y, handleStartRename, handleOpenColorPicker, handleOpenWorktreeCreateDialog, onUpdateProject, onArchiveProject, handleConfirmDelete, isWorktreeCreating]
  )

  const getArchivedContextMenuItems = useCallback(
    (projectId: string): ContextMenuItem[] => {
      return [
        {
          label: 'Restore',
          icon: <RotateCcw size={14} />,
          onClick: () => onRestoreProject(projectId)
        },
        {
          label: 'Delete',
          icon: <Trash2 size={14} />,
          onClick: () => handleConfirmDelete(projectId),
          variant: 'danger'
        }
      ]
    },
    [onRestoreProject, handleConfirmDelete]
  )

  const colorPickerProject = projects.find((p) => p.id === colorPicker.projectId)

  // Filter active and archived projects
  const activeProjects = projects.filter((p) => !p.isArchived)
  const archivedProjects = projects.filter((p) => p.isArchived)

  // Determine which menu items to show based on project archived status
  const getMenuItems = useCallback(
    (projectId: string): ContextMenuItem[] => {
      const project = projects.find((p) => p.id === projectId)
      if (project?.isArchived) {
        return getArchivedContextMenuItems(projectId)
      }
      return getContextMenuItems(projectId)
    },
    [projects, getContextMenuItems, getArchivedContextMenuItems]
  )

  return (
    <aside className="w-64 bg-card border-r border-border flex flex-col flex-shrink-0">
      {/* Header */}
      <div className="h-10 flex items-center px-4 border-b border-border">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Projects
        </span>
      </div>

      {/* Project List */}
      <div className="flex-1 overflow-y-auto py-2">
        {activeProjects.length === 0 && archivedProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 text-center opacity-60">
            <p className="text-sm font-medium text-muted-foreground">No projects yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create your first project to get started
            </p>
          </div>
        ) : (
          <>
            <Reorder.Group
              axis="y"
              values={activeProjects}
              onReorder={(reordered) => onReorderProjects(reordered.map((p) => p.id))}
              className="flex flex-col"
            >
              {activeProjects.map((project, index) => (
                <Reorder.Item
                  key={project.id}
                  value={project}
                  className="list-none"
                  whileDrag={{ scale: 1.02, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
                >
                  <div>
                    <ProjectItem
                      project={project}
                      isActive={project.id === activeProjectId}
                      isEditing={editingId === project.id}
                      editName={editName}
                      shortcut={`Ctrl+${index + 1}`}
                      onClick={() => {
                        onSelectProject(project.id)
                        navigate('/')
                      }}
                      onContextMenu={(e) => handleContextMenu(e, project.id)}
                      onEditNameChange={setEditName}
                      onSaveRename={() => handleSaveRename(project.id)}
                      onCancelRename={handleCancelRename}
                    />
                    <WorktreeProjectSection
                      projectId={project.id}
                      onWorktreeSelect={(worktreeId) => {
                        // TODO: Handle worktree selection (open terminal, etc.)
                        console.log('Selected worktree:', worktreeId, 'in project:', project.id)
                      }}
                    />
                  </div>
                </Reorder.Item>
              ))}
            </Reorder.Group>

            {/* Archived Projects Section */}
            {archivedProjects.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className="w-full flex items-center px-4 py-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase hover:bg-secondary/50 transition-colors"
                >
                  {showArchived
                  ? <ChevronDown size={14} className="mr-2" />
                  : <ChevronRight size={14} className="mr-2" />}
                  Archived ({archivedProjects.length})
                </button>
                {showArchived && archivedProjects.map((project) => (
                  <ArchivedProjectItem
                    key={project.id}
                    project={project}
                    onClick={() => {
                      onSelectProject(project.id)
                      navigate('/')
                    }}
                    onContextMenu={(e) => handleContextMenu(e, project.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Quick Navigation */}
      <div className="border-t border-border py-2">
        <NavItem
          icon={<Terminal size={16} />}
          isActive={location.pathname === '/'}
          onClick={() => navigate('/')}
        >
          Workspace
        </NavItem>
        <NavItem
          icon={<Camera size={16} />}
          isActive={location.pathname === '/snapshots'}
          onClick={() => navigate('/snapshots')}
        >
          Snapshots
        </NavItem>
        <NavItem
          icon={<Settings size={16} />}
          isActive={location.pathname === '/settings'}
          onClick={() => navigate('/settings')}
        >
          Settings
        </NavItem>
        <NavItem
          icon={<SlidersHorizontal size={16} />}
          isActive={location.pathname === '/preferences'}
          onClick={() => navigate('/preferences')}
        >
          Preferences
        </NavItem>
      </div>

      {/* Actions */}
      <div className="border-t border-border pt-1 pb-2">
        <SidebarAction icon={<Plus size={16} />} onClick={onNewProject}>
          New Project
        </SidebarAction>
        <SidebarAction icon={<FolderOpen size={16} />}>Scan Directories</SidebarAction>
        <SidebarAction icon={<Upload size={16} />}>Import Config</SidebarAction>
      </div>

      {/* Context Menu */}
      {contextMenu.isOpen && (
        <ContextMenu
          items={getMenuItems(contextMenu.projectId)}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}

      {/* Color Picker Popover */}
      {colorPicker.isOpen && colorPickerProject && (
        <ColorPickerPopover
          x={colorPicker.x}
          y={colorPicker.y}
          currentColor={colorPickerProject.color}
          onSelectColor={handleColorChange}
          onClose={closeColorPicker}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title="Delete Project"
        message={`Are you sure you want to delete "${deleteConfirm.projectName}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={handleCancelDelete}
      />

      {/* Worktree Create Dialog */}
      {worktreeCreateDialog.isOpen && (
        <WorktreeCreateDialog
          isOpen={worktreeCreateDialog.isOpen}
          projectId={worktreeCreateDialog.projectId}
          projectName={worktreeCreateDialog.projectName}
          projectPath={worktreeCreateDialog.projectPath ?? ''}
          onClose={() => setWorktreeCreateDialog({ isOpen: false, projectId: '', projectName: '', projectPath: '' })}
          onSuccess={handleWorktreeCreated}
          onCreatingChange={setIsWorktreeCreating}
        />
      )}
    </aside>
  )
}

interface ProjectItemProps {
  project: Project
  isActive: boolean
  isEditing: boolean
  editName: string
  shortcut: string
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onEditNameChange: (name: string) => void
  onSaveRename: () => void
  onCancelRename: () => void
}

function ProjectItem({
  project,
  isActive,
  isEditing,
  editName,
  shortcut,
  onClick,
  onContextMenu,
  onEditNameChange,
  onSaveRename,
  onCancelRename
}: ProjectItemProps): React.JSX.Element {
  const colors = getColorClasses(project.color)
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
    <button
      onClick={isEditing ? undefined : onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'w-full flex items-center px-4 py-2 transition-colors group text-left',
        isActive ? 'bg-secondary' : 'hover:bg-secondary/50'
      )}
    >
      <span
        className={cn(
          'w-2.5 h-2.5 rounded-full mr-3 flex-shrink-0',
          colors.bg,
          isActive && `shadow-sm ${colors.shadow}`
        )}
      />
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editName}
          onChange={(e) => onEditNameChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={onSaveRename}
          className="flex-1 bg-secondary border border-border rounded px-2 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={cn(
            'text-sm font-medium transition-colors flex-1',
            isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
          )}
        >
          {project.name}
        </span>
      )}
      {!isEditing && (
        <span
          className={cn(
            'ml-auto text-xs font-mono text-muted-foreground transition-opacity',
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          {shortcut}
        </span>
      )}
    </button>
  )
}

interface ArchivedProjectItemProps {
  project: Project
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function ArchivedProjectItem({
  project,
  onClick,
  onContextMenu
}: ArchivedProjectItemProps): React.JSX.Element {
  const colors = getColorClasses(project.color)

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="w-full flex items-center px-4 py-2 transition-colors group text-left opacity-60 hover:opacity-100"
    >
      <span
        className={cn(
          'w-2.5 h-2.5 rounded-full mr-3 flex-shrink-0',
          colors.bg
        )}
      />
      <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground flex-1">
        {project.name}
      </span>
      <Archive size={12} className="text-muted-foreground" />
    </button>
  )
}

interface NavItemProps {
  icon: React.ReactNode
  children: React.ReactNode
  isActive?: boolean
  onClick?: () => void
}

function NavItem({ icon, children, isActive, onClick }: NavItemProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center px-4 py-2 text-sm transition-colors',
        isActive
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      )}
    >
      <span className="mr-3">{icon}</span>
      {children}
    </button>
  )
}

interface SidebarActionProps {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
}

function SidebarAction({ icon, children, onClick }: SidebarActionProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center px-4 py-2 text-sm text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
    >
      <span className="mr-3">{icon}</span>
      {children}
    </button>
  )
}
