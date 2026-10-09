import type { DetectedShells } from '@shared/types/ipc.types'
import {
  Archive,
  Edit2,
  Folder,
  FolderPlus,
  GitBranch,
  Palette,
  RotateCcw,
  Settings,
  Terminal,
  Trash2
} from '@/components/icons'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { Project, ProjectGroup } from '@/types/project'

export interface ProjectContextMenuContentProps {
  project: Project
  groups: ProjectGroup[]
  availableShells: DetectedShells | null
  selectProject: (id: string) => void
  onStartRename: (project: Project) => void
  onOpenSettings: (projectId: string) => void
  onOpenColorPicker: (targetId: string, targetType: 'project' | 'group') => void
  onUpdateProject: (id: string, updates: Partial<Project>) => void
  moveProjectToGroup: (projectId: string, targetGroupId: string | null) => void
  onCreateGroupForProject: (projectId: string) => void
  onNewWorktree: (projectId: string) => void
  onArchiveProject: (id: string) => void
  onConfirmDelete: (project: Project) => void
}

/** Right-click menu for an active project row. */
export function ProjectContextMenuContent({
  project,
  groups,
  availableShells,
  selectProject,
  onStartRename,
  onOpenSettings,
  onOpenColorPicker,
  onUpdateProject,
  moveProjectToGroup,
  onCreateGroupForProject,
  onNewWorktree,
  onArchiveProject,
  onConfirmDelete
}: ProjectContextMenuContentProps): React.JSX.Element {
  const isGitRepo = project.isGitRepo ?? false
  const currentGroup = groups.find((g) => g.projectIds.includes(project.id))
  const currentShellPath = availableShells?.available.find((s) => {
    const projectShell = project.defaultShell
    if (!projectShell) return false
    if (projectShell === s.path || projectShell === s.name) return true
    const pathBasename = s.path.split(/[\\/]/).pop()
    return projectShell === pathBasename
  })?.path

  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem
        onSelect={() => {
          selectProject(project.id)
          useSettingsModalStore.getState().openProject()
        }}
      >
        <Settings className="mr-2 h-4 w-4" /> Settings
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onStartRename(project)}>
        <Edit2 className="mr-2 h-4 w-4" /> Rename
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onOpenSettings(project.id)}>
        <Settings className="mr-2 h-4 w-4" /> Project Settings
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onOpenColorPicker(project.id, 'project')}>
        <Palette className="mr-2 h-4 w-4" /> Change Color
      </ContextMenuItem>

      {availableShells && availableShells.available.length > 0 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Terminal className="mr-2 h-4 w-4" /> Default Shell
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuRadioGroup
              value={currentShellPath ?? ''}
              onValueChange={(shellPath: string) =>
                onUpdateProject(project.id, { defaultShell: shellPath })
              }
            >
              {availableShells.available.map((shell) => (
                <ContextMenuRadioItem key={shell.path} value={shell.path}>
                  {shell.displayName}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Folder className="mr-2 h-4 w-4" /> Move to Group
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          <ContextMenuRadioGroup
            value={currentGroup?.id ?? 'root'}
            onValueChange={(targetGroupId: string) =>
              moveProjectToGroup(project.id, targetGroupId === 'root' ? null : targetGroupId)
            }
          >
            <ContextMenuRadioItem value="root">No Group (Root)</ContextMenuRadioItem>
            {groups.map((g) => (
              <ContextMenuRadioItem key={g.id} value={g.id}>
                {g.name}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onCreateGroupForProject(project.id)}>
            <FolderPlus className="mr-2 h-4 w-4" /> Create New Group...
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!isGitRepo}
        onSelect={() => {
          if (isGitRepo) onNewWorktree(project.id)
        }}
      >
        <GitBranch className="mr-2 h-4 w-4" />{' '}
        {isGitRepo ? 'New Worktree' : 'New Worktree (no git repo)'}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onArchiveProject(project.id)}>
        <Archive className="mr-2 h-4 w-4" /> Archive
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => onConfirmDelete(project)}>
        <Trash2 className="mr-2 h-4 w-4" /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Right-click menu for an archived project row. */
export function ArchivedProjectContextMenuContent({
  project,
  onRestoreProject,
  onConfirmDelete
}: {
  project: Project
  onRestoreProject: (id: string) => void
  onConfirmDelete: (project: Project) => void
}): React.JSX.Element {
  return (
    <ContextMenuContent className="w-48">
      <ContextMenuItem onSelect={() => onRestoreProject(project.id)}>
        <RotateCcw className="mr-2 h-4 w-4" /> Restore
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => onConfirmDelete(project)}>
        <Trash2 className="mr-2 h-4 w-4" /> Delete
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
