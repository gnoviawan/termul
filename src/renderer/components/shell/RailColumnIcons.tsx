import { toast } from 'sonner'
import { FolderTree, GitBranch, Github, MessageSquare } from '@/components/icons'
import { columnTabId } from '@/components/shell/ColumnTabs'
import { RailButton } from '@/components/shell/rail-button'
import { useColumnWorkingCopy } from '@/components/shell/use-column-working-copy'
import { CountBadge } from '@/components/ui/count-badge'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import { type ShellLastColumnTab, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useSSHWorkspaceOpen } from '@/stores/ssh-store'
import type { Project } from '@/types/project'

const NEED_PROJECT = 'Open a project first'

/** Frames to wait for the revealed Side panel to mount its tab bar. */
const FOCUS_FRAMES = 10

/** Focuses the Side panel's tab once it mounts (the Rail icon unmounts). */
function focusPanelTab(tab: ShellLastColumnTab): void {
  let frames = 0
  const attempt = (): void => {
    const el = document.getElementById(columnTabId(tab))
    if (el) el.focus()
    else if (++frames < FOCUS_FRAMES) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/**
 * Collapsed Rail's Column tab icons (CAP-2): Chats, Explorer, Changes and GitHub.
 * The Rail shows them only while the Side panel is off screen (see
 * `showsFileColumn`; the panel shows its own tab bar), so none is pressed.
 * Each selects the project's Column tab, shows a hidden Side panel and moves
 * focus to the panel's tab, because this icon unmounts. With the SSH
 * workspace open the tab is never written (the click only shows the column).
 * Every write goes through the shell-layout store.
 */
export function RailColumnIcons({
  activeProject,
  onOpenPanel
}: {
  activeProject: Project | undefined
  /** Called when a tab click is about to open the Side panel. */
  onOpenPanel?: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const projectId = activeProject?.id
  const hasProject = Boolean(activeProject)
  const panelVisible = useFileExplorerVisible()
  const sshOpen = useSSHWorkspaceOpen()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const { cwd } = useColumnWorkingCopy(activeProject)
  const changedCount = useGitStatusStore(selectChangedFileCount(cwd))
  const { runningProjectIds } = useAgentChatProjectSignals()
  const isRunning = projectId ? runningProjectIds.has(projectId) : false

  const select = (tab: ShellLastColumnTab, event: React.MouseEvent): void => {
    if (!projectId) return
    if (!sshOpen) useShellLayoutStore.getState().setLastColumnTab(projectId, tab)
    if (!panelVisible) {
      onOpenPanel?.(event)
      void updatePanelVisibility('fileExplorerVisible', true)
        .then(() => {
          if (!sshOpen) focusPanelTab(tab)
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Failed to update side panel visibility'
          )
        })
    }
  }

  return (
    <>
      <RailButton
        label="Chats"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="Chats"
        disabled={!hasProject}
        onClick={(event) => select('chats', event)}
        badge={
          isRunning ? (
            <span
              data-testid="rail-chats-live-dot"
              className="pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-sidebar"
            />
          ) : null
        }
      >
        <MessageSquare size={16} />
      </RailButton>

      <RailButton
        label="Explorer"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="Explorer"
        disabled={!hasProject}
        onClick={(event) => select('explorer', event)}
      >
        <FolderTree size={16} />
      </RailButton>

      <RailButton
        label="Changes"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="Changes"
        disabled={!hasProject}
        onClick={(event) => select('changes', event)}
        badge={
          hasProject && changedCount > 0 ? (
            <CountBadge
              count={changedCount}
              max={99}
              data-testid="rail-changes-badge"
              className="pointer-events-none absolute -top-0.5 -right-1 h-3.5 min-w-3.5 text-4xs ring-2 ring-sidebar"
            />
          ) : null
        }
      >
        <GitBranch size={16} />
      </RailButton>

      <RailButton
        label="GitHub"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="GitHub"
        disabled={!hasProject}
        onClick={(event) => select('github', event)}
      >
        <Github size={16} />
      </RailButton>
    </>
  )
}
