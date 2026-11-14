import { Download, FolderPlus, Plus } from '@/components/icons'
import { RailTooltip } from '@/components/shell/rail-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { WriteGate, WriteGateReason } from '@/components/ui/write-gate'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'

interface AddProjectMenuProps {
  onNewProject: () => void
  onNewGroup: () => void
  /**
   * Opens the Import chats dialog for the open project. Absent: no item (no
   * open project or no working copy to import into).
   */
  onImportChats?: () => void
  /** Look of the `+` trigger (the Projects header icon button). */
  buttonClassName: string
}

/**
 * The Rail's single `+` in the Projects header: a menu with `New project`,
 * `New folder group` and `Import chats` (into the open project; it writes to
 * the host, so a read-only server shows it disabled with the reason).
 */
export function AddProjectMenu({
  onNewProject,
  onNewGroup,
  onImportChats,
  buttonClassName
}: AddProjectMenuProps): React.JSX.Element {
  const admitted = useServerAdmitsRemoteWrites()
  return (
    <DropdownMenu>
      <RailTooltip label="Add project or folder group">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={buttonClassName}
            aria-label="Add project or folder group"
            data-testid="header-add-menu"
          >
            <Plus size={14} />
          </button>
        </DropdownMenuTrigger>
      </RailTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onNewProject} data-testid="header-new-project">
          <Plus size={14} aria-hidden="true" className="mr-2 text-muted-foreground" />
          New project
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewGroup} data-testid="header-new-group">
          <FolderPlus size={14} aria-hidden="true" className="mr-2 text-muted-foreground" />
          New folder group
        </DropdownMenuItem>
        {onImportChats && (
          <>
            <DropdownMenuSeparator />
            <WriteGate gated={!admitted} focusable={false} className="flex w-full">
              <DropdownMenuItem
                disabled={!admitted}
                onSelect={onImportChats}
                data-testid="header-import-chats"
              >
                <Download size={14} aria-hidden="true" className="mr-2 text-muted-foreground" />
                Import chats
                {!admitted && <WriteGateReason />}
              </DropdownMenuItem>
            </WriteGate>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
