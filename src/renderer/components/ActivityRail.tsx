import { toast } from 'sonner'
import {
  Edit2,
  FolderKanban,
  GitBranch,
  History,
  MessageSquarePlus,
  Network,
  Palette,
  SlidersHorizontal
} from '@/components/icons'
import { TermulMark } from '@/components/TermulMark'
import { TitleBarShortcutsPopover } from '@/components/TitleBarShortcutsPopover'
import { CountBadge } from '@/components/ui/count-badge'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import { useActiveProject } from '@/stores/project-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
import { useSSHPanelVisible } from '@/stores/ssh-panel-store'

/**
 * 36px rail action. Rest = muted icon; hover = 3% foreground wash; the
 * pressed / open view takes the `.keycap` surface. Disabled icons sit at 40%
 * with no hover.
 */
function railButtonClass(active: boolean): string {
  return cn(
    QUIET_ICON_BUTTON_CLASS,
    'relative flex size-9 shrink-0 rounded-lg disabled:pointer-events-none disabled:opacity-40',
    active && 'keycap text-foreground'
  )
}

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
  /** Opens the project's OpenPencil canvas tab (one click; focuses the existing canvas when already open). */
  onOpenCanvas?: () => void
  /** Whether the canvas can currently be opened (active project has a path). */
  canOpenCanvas?: boolean
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
 * - Top group: projects (command palette), git changes, agent chat, canvas,
 *   git history, SSH panel toggle.
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
  onOpenCanvas,
  canOpenCanvas = false,
  onOpenGitHistory,
  canOpenGitHistory = false,
  isThemePickerOpen = false,
  onToggleThemePicker
}: ActivityRailProps = {}): React.JSX.Element {
  const isSSHPanelVisible = useSSHPanelVisible()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const settingsView = useSettingsModalView()

  const handleToggleSSHPanel = async (): Promise<void> => {
    try {
      await updatePanelVisibility('sshPanelVisible', !isSSHPanelVisible)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update SSH panel visibility')
    }
  }

  const activeProject = useActiveProject()
  const gitCwd = activeProject?.path
  const gitChangeCount = useGitStatusStore(selectChangedFileCount(gitCwd))
  const { runningProjectIds } = useAgentChatProjectSignals()
  const isAgentRunning = activeProject ? runningProjectIds.has(activeProject.id) : false
  const needProject = 'Open a project first'

  return (
    <TooltipProvider delayDuration={400}>
      <nav
        className="w-12 flex flex-col items-center gap-1 bg-background select-none shrink-0"
        aria-label="Global actions"
      >
        {/* Brand mark */}
        <div
          className="w-12 h-11 flex items-center justify-center text-foreground shrink-0"
          data-tauri-drag-region={isMac ? true : undefined}
        >
          <TermulMark size={22} className="pointer-events-none" />
        </div>

        <div className="w-6 h-px bg-border/60" aria-hidden="true" />

        <RailButton
          label="Projects"
          aria-label="Open projects"
          disabled={!onOpenCommandPalette}
          onClick={() => onOpenCommandPalette?.()}
        >
          <FolderKanban size={16} />
        </RailButton>

        <RailButton
          label="Git changes"
          hint={canOpenGitChanges ? undefined : needProject}
          aria-label="Open git changes"
          disabled={!onOpenGitChanges || !canOpenGitChanges}
          onClick={() => onOpenGitChanges?.()}
          badge={
            canOpenGitChanges && gitChangeCount > 0 ? (
              <CountBadge
                count={gitChangeCount}
                max={99}
                data-testid="rail-git-badge"
                className="pointer-events-none absolute -top-0.5 -right-1 h-3.5 min-w-3.5 text-4xs ring-2 ring-background"
              />
            ) : null
          }
        >
          <GitBranch size={16} />
        </RailButton>

        <RailButton
          label="New agent chat"
          hint={canOpenAgentChat ? undefined : needProject}
          aria-label="New agent chat"
          disabled={!onOpenAgentChat || !canOpenAgentChat}
          onClick={() => onOpenAgentChat?.()}
          badge={
            isAgentRunning ? (
              <span
                data-testid="rail-agent-live-dot"
                className="pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
              />
            ) : null
          }
        >
          <MessageSquarePlus size={16} />
        </RailButton>

        <RailButton
          label="Open canvas"
          hint={canOpenCanvas ? undefined : needProject}
          aria-label="Open canvas"
          disabled={!onOpenCanvas || !canOpenCanvas}
          onClick={() => onOpenCanvas?.()}
        >
          <Edit2 size={16} />
        </RailButton>

        <RailButton
          label="Git history"
          hint={canOpenGitHistory ? undefined : needProject}
          aria-label="Open git history"
          disabled={!onOpenGitHistory || !canOpenGitHistory}
          onClick={() => onOpenGitHistory?.()}
        >
          <History size={16} />
        </RailButton>

        {/* SSH panel toggle — desktop only (issue #843): hidden on web rather
            than disabled-with-title, since the whole SSH panel is a
            desktop-only surface there. */}
        {isTauriContext() && (
          <RailButton
            label="Toggle SSH panel"
            aria-label={isSSHPanelVisible ? 'Hide SSH panel' : 'Show SSH panel'}
            pressed={isSSHPanelVisible}
            onClick={() => {
              void handleToggleSSHPanel()
            }}
          >
            <Network size={16} />
          </RailButton>
        )}

        <div className="mt-auto flex flex-col items-center gap-1 pb-1">
          <TitleBarShortcutsPopover
            buttonClassName={railButtonClass(Boolean(isShortcutsOpen))}
            open={isShortcutsOpen}
            onOpenChange={onShortcutsOpenChange}
          />

          <RailButton
            label="Preferences"
            aria-label="Open preferences"
            pressed={settingsView === 'app'}
            onClick={() => useSettingsModalStore.getState().openApp()}
          >
            <SlidersHorizontal size={16} />
          </RailButton>

          <RailButton
            label="Color themes"
            aria-label="Color themes"
            pressed={onToggleThemePicker ? isThemePickerOpen : undefined}
            disabled={!onToggleThemePicker}
            onClick={() => onToggleThemePicker?.()}
          >
            <Palette size={16} />
          </RailButton>
        </div>
      </nav>
    </TooltipProvider>
  )
}

/** Number of distinct changed paths (a staged + unstaged `MM` file counts once). */
interface RailButtonProps {
  label: string
  /** Muted second line in the tooltip (e.g. why the action is disabled). */
  hint?: string
  'aria-label': string
  disabled?: boolean
  /** Sets `aria-pressed` and the keycap "you are here" surface. */
  pressed?: boolean
  badge?: React.ReactNode
  /** Runs after the click stops propagating. */
  onClick: () => void
  children: React.ReactNode
}

function RailButton({
  label,
  hint,
  'aria-label': ariaLabel,
  disabled = false,
  pressed,
  badge,
  onClick,
  children
}: RailButtonProps): React.JSX.Element {
  const button = (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={railButtonClass(pressed ?? false)}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      disabled={disabled}
    >
      {children}
      {badge}
    </button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events, so the wrapper carries
            the tooltip that explains why the action is off. */}
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="right" className="flex flex-col gap-0.5 px-2.5 py-1.5 text-xs">
        <span className="text-popover-foreground">{label}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
