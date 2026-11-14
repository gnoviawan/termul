import { motion } from 'framer-motion'
import { lazy, Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { ChatRoute } from '@/components/ChatRoute'
import { FolderKanban } from '@/components/icons'
import { useTopRow } from '@/components/shell/top-row-context'
import { Button } from '@/components/ui/button'
import { ProjectSwitchIndicator } from '@/components/workspace/ProjectSwitchIndicator'
import { ProjectTreeHost, useMountedProjectIds } from '@/components/workspace/ProjectTreeHost'
import { useMobileActiveLeaf } from '@/hooks/use-mobile-active-leaf'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { useTerminalActions } from '@/stores/terminal-store'
import { useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

const SSHWorkspace = lazy(() =>
  import('@/components/ssh/SSHWorkspace').then((m) => ({ default: m.SSHWorkspace }))
)

interface WorkspaceMainProps {
  isMobileWebShell: boolean
  isWorkspaceRoute: boolean
  projects: Project[]
  ssh: SSHWorkspaceState
  setIsNewProjectModalOpen: (open: boolean) => void
  handleCloseTerminal: (id: string, tabId: string) => boolean
  handleCloseEditorTab: (filePath: string) => boolean
  handleCloseTabs: (targetTabs: WorkspaceTab[]) => void
  closingTerminalIds: string[]
}

/** The workspace main area: SSH workspace, empty state, pane tree or routed child. */
export function WorkspaceMain({
  isMobileWebShell,
  isWorkspaceRoute,
  projects,
  ssh,
  setIsNewProjectModalOpen,
  handleCloseTerminal,
  handleCloseEditorTab,
  handleCloseTabs,
  closingTerminalIds
}: WorkspaceMainProps): React.JSX.Element {
  const { renameTerminal } = useTerminalActions()
  // Every visited project's tree stays mounted; only the active one is visible.
  const mountedProjectIds = useMountedProjectIds()
  const activeTreeProjectId = useWorkspaceStore((state) => state.activeProjectId)
  // Flagged shell only: the SSH header is the top row when it owns the window
  // controls (no provider on the classic and mobile shells = unchanged).
  const topRowValue = useTopRow()
  const sshTopRow =
    topRowValue?.roles.controlsOwner === 'ssh-header'
      ? {
          dragRegion: topRowValue.platform.dragRegions,
          windowControls: topRowValue.platform.windowControls,
          startSlot: topRowValue.roles.showPanelOwner === 'ssh-header'
        }
      : undefined
  // Mobile shell only: a split synced from desktop collapses to the active
  // leaf (read-only; null on desktop so the desktop node is unchanged).
  const mobileActiveLeaf = useMobileActiveLeaf(isMobileWebShell)

  return (
    <>
      {ssh.workspaceOpen ? (
        <Suspense fallback={<ShellSkeleton />}>
          <SSHWorkspace topRow={sshTopRow} />
        </Suspense>
      ) : projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center bg-background px-6">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="flex max-w-md flex-col items-center text-center"
          >
            <div className="mb-6">
              <FolderKanban className="h-24 w-24 text-muted-foreground/50" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">No Projects Yet</h2>
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
              Create your first project to organize your terminals, snapshots, and commands
            </p>
            <Button type="button" size="sm" onClick={() => setIsNewProjectModalOpen(true)}>
              Create Your First Project
            </Button>
          </motion.div>
        </div>
      ) : (
        <>
          {isWorkspaceRoute ? (
            <>
              <ChatRoute />
              <div className="relative h-full min-h-0 flex-1 overflow-hidden">
                <ProjectSwitchIndicator />
                {mountedProjectIds.map((projectId) => {
                  const isActiveProject = projectId === activeTreeProjectId
                  return (
                    <ProjectTreeHost
                      key={projectId}
                      projectId={projectId}
                      isActiveProject={isActiveProject}
                      leafOverride={isActiveProject ? mobileActiveLeaf : null}
                      onCloseTerminal={handleCloseTerminal}
                      onRenameTerminal={renameTerminal}
                      onCloseEditorTab={handleCloseEditorTab}
                      onCloseTabs={handleCloseTabs}
                      closingTerminalIds={closingTerminalIds}
                    />
                  )
                })}
              </div>
            </>
          ) : (
            <div className="relative flex-1 overflow-hidden bg-background">
              <div className="h-full w-full">
                <Outlet />
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
