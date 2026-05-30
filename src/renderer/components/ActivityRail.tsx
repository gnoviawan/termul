import { PanelLeft, PanelRight, SlidersHorizontal, FolderKanban, GitBranch } from 'lucide-react'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { TermulMark } from '@/components/TermulMark'
import { useNavigate, useLocation } from 'react-router-dom'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { toast } from 'sonner'
import { isMac } from '@/lib/platform'

const railButtonClass =
  'w-12 h-11 flex items-center justify-center hover:bg-secondary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset'

interface ActivityRailProps {
  isShortcutsOpen?: boolean
  onShortcutsOpenChange?: (open: boolean) => void
  /** Opens the command palette (project switcher / launcher). */
  onOpenCommandPalette?: () => void
  /** Opens a git changes tab in the active pane. */
  onOpenGitChanges?: () => void
  /** Whether a git changes tab can currently be opened (active project has a path). */
  canOpenGitChanges?: boolean
}

/**
 * Vertical activity rail (VSCode-style) that hosts the app's global actions.
 *
 * Layout:
 * - macOS: a top spacer clears the native traffic lights and acts as a drag region.
 *   On macOS there is no separate top title strip, so this rail also carries the
 *   window-drag affordance at the top-left.
 * - Brand mark at the top, followed by a separator.
 * - Top group: projects (command palette), git changes.
 * - Bottom group (pinned via `mt-auto`): sidebar toggle, file explorer toggle,
 *   keyboard shortcuts, preferences.
 *
 * All actions preserve the behavior contracts that previously lived in the
 * top title bar: persistence-aware panel toggles with error toasts, and
 * accessible labels/states.
 */
export function ActivityRail({
  isShortcutsOpen,
  onShortcutsOpenChange,
  onOpenCommandPalette,
  onOpenGitChanges,
  canOpenGitChanges = false
}: ActivityRailProps = {}): React.JSX.Element {
  const isSidebarVisible = useSidebarVisible()
  const isExplorerVisible = useFileExplorerVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const navigate = useNavigate()
  const location = useLocation()

  const handleToggleSidebar = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('sidebarVisible', !isSidebarVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update sidebar visibility')
    }
  }

  const handleToggleFileExplorer = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('fileExplorerVisible', !isExplorerVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update file explorer visibility')
    }
  }

  return (
    <nav
      className="w-12 flex flex-col items-center bg-background select-none shrink-0"
      aria-label="Global actions"
    >
      {/* macOS: top spacer clears native traffic lights and stays draggable */}
      {isMac && <div className="h-7 w-full shrink-0" data-tauri-drag-region />}

      {/* Brand mark. On Windows/Linux it also offsets the actions from the top edge. */}
      <div
        className="w-12 h-11 flex items-center justify-center text-foreground shrink-0"
        data-tauri-drag-region={isMac ? true : undefined}
      >
        <TermulMark size={22} className="pointer-events-none" />
      </div>

      <div className="w-6 h-px bg-border/60 my-1" aria-hidden="true" />

      <button
        onClick={(e) => {
          e.stopPropagation()
          onOpenCommandPalette?.()
        }}
        className={railButtonClass}
        title="Projects"
        aria-label="Open projects"
        disabled={!onOpenCommandPalette}
      >
        <FolderKanban size={18} className="text-muted-foreground" />
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onOpenGitChanges?.()
        }}
        className={railButtonClass}
        title={canOpenGitChanges ? 'Git changes' : 'Git changes (open a project first)'}
        aria-label="Open git changes"
        disabled={!onOpenGitChanges || !canOpenGitChanges}
      >
        <GitBranch
          size={18}
          className={canOpenGitChanges ? 'text-muted-foreground' : 'text-muted-foreground/40'}
        />
      </button>

      <div className="mt-auto flex flex-col items-center pb-1">
        <button
          onClick={(e) => {
            void handleToggleSidebar(e)
          }}
          className={railButtonClass}
          title="Toggle sidebar"
          aria-label={isSidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={isSidebarVisible}
        >
          <PanelLeft
            size={18}
            className={isSidebarVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <button
          onClick={(e) => {
            void handleToggleFileExplorer(e)
          }}
          className={railButtonClass}
          title="Toggle file explorer"
          aria-label={isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          aria-pressed={isExplorerVisible}
        >
          <PanelRight
            size={18}
            className={isExplorerVisible ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>

        <TitleBarShortcutsPopover
          buttonClassName={railButtonClass}
          open={isShortcutsOpen}
          onOpenChange={onShortcutsOpenChange}
        />

        <button
          onClick={(e) => {
            e.stopPropagation()
            navigate('/preferences')
          }}
          className={railButtonClass}
          title="Preferences"
          aria-label="Open preferences"
          aria-current={location.pathname === '/preferences' ? 'page' : undefined}
        >
          <SlidersHorizontal
            size={18}
            className={location.pathname === '/preferences' ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>
      </div>
    </nav>
  )
}
