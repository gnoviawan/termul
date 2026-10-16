import { toast } from 'sonner'
import { FolderTree, GitBranch, MessageSquare } from '@/components/icons'
import { RailButton } from '@/components/shell/rail-button'
import { useColumnWorkingCopy } from '@/components/shell/use-column-working-copy'
import { CountBadge } from '@/components/ui/count-badge'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { useUpdatePanelVisibility } from '@/hooks/use-app-settings'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import { selectChangedFileCount, useGitStatusStore } from '@/stores/git-status-store'
import {
  type ShellLastColumnTab,
  useLastColumnTab,
  useShellLayoutStore
} from '@/stores/shell-layout-store'
import { useSSHWorkspaceOpen } from '@/stores/ssh-store'
import type { Project } from '@/types/project'

const NEED_PROJECT = 'Open a project first'

/**
 * Collapsed Rail's Column tab icons (CAP-2): Chats, Explorer and Changes.
 * Each selects the project's Column tab and shows a hidden Side panel; the
 * pressed one follows the project's selected tab while the panel is visible.
 * With the SSH workspace open the tab is never written (the click only shows
 * the column). Every write goes through the shell-layout store.
 */
export function RailColumnIcons({
  activeProject
}: {
  activeProject: Project | undefined
}): React.JSX.Element {
  const projectId = activeProject?.id
  const hasProject = Boolean(activeProject)
  const selected: ShellLastColumnTab = useLastColumnTab(projectId ?? '') ?? 'chats'
  const panelVisible = useFileExplorerVisible()
  const sshOpen = useSSHWorkspaceOpen()
  const updatePanelVisibility = useUpdatePanelVisibility()
  const { cwd } = useColumnWorkingCopy(activeProject)
  const changedCount = useGitStatusStore(selectChangedFileCount(cwd))
  const { runningProjectIds } = useAgentChatProjectSignals()
  const isRunning = projectId ? runningProjectIds.has(projectId) : false

  const select = (tab: ShellLastColumnTab): void => {
    if (!projectId) return
    if (!sshOpen) useShellLayoutStore.getState().setLastColumnTab(projectId, tab)
    if (!panelVisible) {
      void updatePanelVisibility('fileExplorerVisible', true).catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : 'Failed to update side panel visibility'
        )
      })
    }
  }

  const pressed = (tab: ShellLastColumnTab): boolean =>
    hasProject && panelVisible && !sshOpen ? selected === tab : false

  return (
    <>
      <RailButton
        label="Chats"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="Chats"
        disabled={!hasProject}
        pressed={pressed('chats')}
        onClick={() => select('chats')}
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
        pressed={pressed('explorer')}
        onClick={() => select('explorer')}
      >
        <FolderTree size={16} />
      </RailButton>

      <RailButton
        label="Changes"
        hint={hasProject ? undefined : NEED_PROJECT}
        aria-label="Changes"
        disabled={!hasProject}
        pressed={pressed('changes')}
        onClick={() => select('changes')}
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
    </>
  )
}
