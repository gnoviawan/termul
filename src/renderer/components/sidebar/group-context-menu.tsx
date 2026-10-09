import { Edit2, FolderPlus, Palette, Plus, Trash2 } from '@/components/icons'
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import type { Project, ProjectGroup } from '@/types/project'

export interface GroupContextMenuContentProps {
  group: ProjectGroup
  /** Non-archived projects, offered in the "Add Project" submenu. */
  activeProjects: Project[]
  onStartRename: (group: ProjectGroup) => void
  onOpenColorPicker: (targetId: string, targetType: 'project' | 'group') => void
  moveProjectToGroup: (projectId: string, targetGroupId: string | null) => void
  onImportProject: (groupId: string) => void
  onConfirmDelete: (group: ProjectGroup, deleteProjects: boolean) => void
}

/** Right-click menu for a project group folder header. */
export function GroupContextMenuContent({
  group,
  activeProjects,
  onStartRename,
  onOpenColorPicker,
  moveProjectToGroup,
  onImportProject,
  onConfirmDelete
}: GroupContextMenuContentProps): React.JSX.Element {
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={() => onStartRename(group)}>
        <Edit2 className="mr-2 h-4 w-4" /> Rename Group
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onOpenColorPicker(group.id, 'group')}>
        <Palette className="mr-2 h-4 w-4" /> Change Color
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Plus className="mr-2 h-4 w-4" /> Add Project
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-48">
          {activeProjects.map((p) => (
            <ContextMenuCheckboxItem
              key={p.id}
              checked={group.projectIds.includes(p.id)}
              onCheckedChange={(checked) => moveProjectToGroup(p.id, checked ? group.id : null)}
              onSelect={(e) => e.preventDefault()}
            >
              {p.name}
            </ContextMenuCheckboxItem>
          ))}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onImportProject(group.id)}>
            <FolderPlus className="mr-2 h-4 w-4" /> Import Project...
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => onConfirmDelete(group, false)}>
        <Trash2 className="mr-2 h-4 w-4" /> Delete Group (Keep Projects)
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => onConfirmDelete(group, true)}>
        <Trash2 className="mr-2 h-4 w-4" /> Delete Group &amp; All Projects
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
