import { toast } from 'sonner'
import {
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  PanelRight,
  RefreshCw
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PANEL_HEADER_CLASS, PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'

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
 * Explorer panel header: label, New file, New folder, Collapse all, and a
 * More menu with Refresh (and, on web, the panel hide action that the
 * titlebar holds on desktop).
 */
export function ExplorerHeader({
  actionsDisabled,
  onNewFile,
  onNewFolder,
  onCollapseAll,
  onRefresh
}: ExplorerHeaderProps): React.JSX.Element {
  const isDesktop = isTauriContext()
  const isVisible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()

  const handleTogglePanel = async (): Promise<void> => {
    try {
      await updatePanelVisibility('fileExplorerVisible', !isVisible)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to update file explorer visibility'
      )
    }
  }

  return (
    <div className={PANEL_HEADER_CLASS}>
      <span className="label-panel">Explorer</span>
      <div className="flex items-center gap-0.5">
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
              // On desktop the menu holds only Refresh, so it follows the
              // same disabled rule as the other actions.
              disabled={isDesktop && actionsDisabled}
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
            {!isDesktop && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void handleTogglePanel()}>
                  <PanelRight className="mr-2 h-3.5 w-3.5" />
                  {isVisible ? 'Hide file explorer' : 'Show file explorer'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
