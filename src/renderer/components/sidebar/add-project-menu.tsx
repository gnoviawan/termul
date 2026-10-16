import { FolderPlus, Plus } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface AddProjectMenuProps {
  onNewProject: () => void
  onNewGroup: () => void
  /** Look of the `+` trigger (the Projects header icon button). */
  buttonClassName: string
}

/**
 * The Rail's single `+` in the Projects header: a menu with `New project` and
 * `New folder group`, replacing the two header buttons of the classic sidebar.
 */
export function AddProjectMenu({
  onNewProject,
  onNewGroup,
  buttonClassName
}: AddProjectMenuProps): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={buttonClassName}
          title="Add project or folder group"
          aria-label="Add project or folder group"
          data-testid="header-add-menu"
        >
          <Plus size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onNewProject} data-testid="header-new-project">
          <Plus size={14} aria-hidden="true" className="mr-2 text-muted-foreground" />
          New project
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewGroup} data-testid="header-new-group">
          <FolderPlus size={14} aria-hidden="true" className="mr-2 text-muted-foreground" />
          New folder group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
