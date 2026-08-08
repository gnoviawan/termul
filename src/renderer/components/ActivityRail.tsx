import {
  FolderKanban,
  GitBranch,
  History,
  MessageSquarePlus,
  Network,
  Palette,
  SlidersHorizontal
} from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { TermulMark } from '@/components/TermulMark'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useSSHPanelVisible } from '@/stores/ssh-panel-store'

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
  /** Opens the New Agent Chat dialog. */
  onOpenAgentChat?: () => void
  /** Whether a new agent chat can currently be started (active project has a path). */
  canOpenAgentChat?: boolean
  /** Opens a git history (commit graph) tab in the active pane. */
  onOpenGitHistory?: () => void
  /** Whether a git history tab can currently be opened (active project has a path). */
  canOpenGitHistory?: boolean
  /** Whether the color theme picker overlay is open. */
  isThemePickerOpen?: boolean
  /** Toggle the color theme picker (opens beside the rail). */
  onToggleThemePicker?: () => void
}

/**
 * Vertical activity rail (VSCode-style) that hosts the app's global actions.
 *
 * Layout:
 * - macOS: WorkspaceLayout renders a full-width titlebar zone above this rail;
 *   the brand row stays draggable for top-left window moves.
 * - Brand mark at the top, followed by a separator.
 * - Top group: projects (command palette), git changes, SSH panel toggle.
 * - Bottom group (pinned via `mt-auto`): keyboard shortcuts, preferences,
 *   color themes. Sidebar/file-explorer visibility toggles moved to the
 *   titlebar strip (TitleBar / MacOsTitlebarStrip) beside the OS window
 *   controls.
 *
 * The SSH panel toggle preserves the persistence-aware updater, error-toast,
 * and accessible-label contracts that previously lived in the top title bar.
 * Sidebar/file-explorer visibility toggles now live in the titlebar strip.
 */
export function ActivityRail({
  isShortcutsOpen,
  onShortcutsOpenChange,
  onOpenCommandPalette,
  onOpenGitChanges,
  canOpenGitChanges = false,
  onOpenAgentChat,
  canOpenAgentChat = false,
  onOpenGitHistory,
  canOpenGitHistory = false,
  isThemePickerOpen = false,
  onToggleThemePicker
}: ActivityRailProps = {}): React.JSX.Element {
  const isSSHPanelVisible = useSSHPanelVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const navigate = useNavigate()
  const location = useLocation()

  const handleToggleSSHPanel = async (e: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    e.stopPropagation()
    try {
      await updatePanelVisibility('sshPanelVisible', !isSSHPanelVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update SSH panel visibility')
    }
  }

  return (
    <nav
      className="w-12 flex flex-col items-center bg-background select-none shrink-0"
      aria-label="Global actions"
    >
      {/* Brand mark */}
      <div
        className="w-12 h-11 flex items-center justify-center text-foreground shrink-0"
        data-tauri-drag-region={isMac ? true : undefined}
      >
        <TermulMark size={22} className="pointer-events-none" />
      </div>

      <div className="w-6 h-px bg-border/60 my-1" aria-hidden="true" />

      <button
        type="button"
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
        type="button"
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

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenAgentChat?.()
        }}
        className={railButtonClass}
        title={canOpenAgentChat ? 'New agent chat' : 'New agent chat (open a project first)'}
        aria-label="New agent chat"
        disabled={!onOpenAgentChat || !canOpenAgentChat}
      >
        <MessageSquarePlus
          size={18}
          className={canOpenAgentChat ? 'text-muted-foreground' : 'text-muted-foreground/40'}
        />
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenGitHistory?.()
        }}
        className={railButtonClass}
        title={canOpenGitHistory ? 'Git history' : 'Git history (open a project first)'}
        aria-label="Open git history"
        disabled={!onOpenGitHistory || !canOpenGitHistory}
      >
        <History
          size={18}
          className={canOpenGitHistory ? 'text-muted-foreground' : 'text-muted-foreground/40'}
        />
      </button>

      <button
        type="button"
        onClick={(e) => {
          void handleToggleSSHPanel(e)
        }}
        className={railButtonClass}
        title={isTauriContext() ? 'Toggle SSH panel' : 'SSH is desktop-only'}
        aria-label={isSSHPanelVisible ? 'Hide SSH panel' : 'Show SSH panel'}
        aria-pressed={isSSHPanelVisible}
        disabled={!isTauriContext()}
      >
        <Network
          size={18}
          className={
            isSSHPanelVisible
              ? 'text-foreground'
              : isTauriContext()
                ? 'text-muted-foreground'
                : 'text-muted-foreground/40'
          }
        />
      </button>

      <div className="mt-auto flex flex-col items-center pb-1">
        <TitleBarShortcutsPopover
          buttonClassName={railButtonClass}
          open={isShortcutsOpen}
          onOpenChange={onShortcutsOpenChange}
        />

        <button
          type="button"
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
            className={
              location.pathname === '/preferences' ? 'text-foreground' : 'text-muted-foreground'
            }
          />
        </button>

        <button
          type="button"
          onClick={
            onToggleThemePicker
              ? (e) => {
                  e.stopPropagation()
                  onToggleThemePicker()
                }
              : undefined
          }
          className={railButtonClass}
          title="Color themes"
          aria-label="Color themes"
          aria-pressed={onToggleThemePicker ? isThemePickerOpen : undefined}
          aria-disabled={!onToggleThemePicker}
          disabled={!onToggleThemePicker}
        >
          <Palette
            size={18}
            className={isThemePickerOpen ? 'text-foreground' : 'text-muted-foreground'}
          />
        </button>
      </div>
    </nav>
  )
}
