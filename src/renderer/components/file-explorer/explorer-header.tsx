import { ChevronsDownUp, FilePlus, FolderPlus, MoreHorizontal, RefreshCw } from '@/components/icons'
import { SidePanelHeader } from '@/components/shell/SidePanelHeader'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'

const ICON_BUTTON_CLASS = `${PANEL_ICON_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground`

interface ExplorerHeaderProps {
  /** No project, or the root failed to load. */
  actionsDisabled: boolean
  onNewFile: () => void
  onNewFolder: () => void
  onCollapseAll: () => void
  onRefresh: () => void
}

/**
 * Explorer view of the right panel: the panel header (Paper "Panel header")
 * with New file, New folder, Collapse all and a More menu with Refresh,
 * then Close.
 */
export function ExplorerHeader({
  actionsDisabled,
  onNewFile,
  onNewFolder,
  onCollapseAll,
  onRefresh
}: ExplorerHeaderProps): React.JSX.Element {
  return (
    <SidePanelHeader title="Explorer">
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={onNewFile}
          disabled={actionsDisabled}
          className={ICON_BUTTON_CLASS}
          title="New File"
          aria-label="New File"
        >
          <FilePlus size={14} />
        </button>
        <button
          type="button"
          onClick={onNewFolder}
          disabled={actionsDisabled}
          className={ICON_BUTTON_CLASS}
          title="New Folder"
          aria-label="New Folder"
        >
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          onClick={onCollapseAll}
          disabled={actionsDisabled}
          className={ICON_BUTTON_CLASS}
          title="Collapse All"
          aria-label="Collapse All"
        >
          <ChevronsDownUp size={14} />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={actionsDisabled}
              className={ICON_BUTTON_CLASS}
              title="More actions"
              aria-label="More explorer actions"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onRefresh} disabled={actionsDisabled}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SidePanelHeader>
  )
}
