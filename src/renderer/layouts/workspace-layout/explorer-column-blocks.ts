import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import type { Project } from '@/types/project'

/**
 * Whether the Side panel column shows its project block (the Side panel with
 * its tab bar).
 */
function showsFileColumn({
  isExplorerVisible,
  activeProject,
  workspaceOpen,
  hasSidePanel
}: {
  isExplorerVisible: boolean
  activeProject: Project | undefined
  workspaceOpen: boolean
  hasSidePanel: boolean
}): boolean {
  return Boolean(isExplorerVisible && activeProject?.path && !(hasSidePanel && workspaceOpen))
}

/**
 * Which blocks the Side panel column shows. Both `false` means the column is
 * gone and the main card sits next to the Rail.
 */
export function getExplorerColumnBlocks({
  isExplorerVisible,
  activeProject,
  ssh,
  hasSidePanel
}: {
  isExplorerVisible: boolean
  activeProject: Project | undefined
  ssh: SSHWorkspaceState
  hasSidePanel: boolean
}): { showFileColumn: boolean; sftpSession: SSHWorkspaceState['activeSSHSession'] | null } {
  const { workspaceOpen, activeSSHSession } = ssh
  const showFileColumn = showsFileColumn({
    isExplorerVisible,
    activeProject,
    workspaceOpen,
    hasSidePanel
  })
  // Remote files of the active, connected session tab.
  const sftpSession =
    workspaceOpen && isExplorerVisible && activeSSHSession?.status === 'connected'
      ? activeSSHSession
      : null
  return { showFileColumn, sftpSession }
}
