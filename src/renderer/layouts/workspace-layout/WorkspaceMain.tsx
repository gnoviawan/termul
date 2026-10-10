import type { ShellInfo } from '@shared/types/ipc.types'
import { motion } from 'framer-motion'
import { lazy, Suspense, useMemo } from 'react'
import { Outlet } from 'react-router-dom'
import { ChatRoute } from '@/components/ChatRoute'
import { FolderKanban } from '@/components/icons'
import { StatusBar } from '@/components/StatusBar'
import { Button } from '@/components/ui/button'
import { PaneRenderer } from '@/components/workspace/PaneRenderer'
import { useMobileActiveLeaf } from '@/hooks/use-mobile-active-leaf'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { useDefaultShell } from '@/stores/app-settings-store'
import { useTerminalActions } from '@/stores/terminal-store'
import {
  findPaneById,
  useFullscreenPaneId,
  usePaneRoot,
  type WorkspaceTab
} from '@/stores/workspace-store'
import type { Project } from '@/types/project'

const SSHWorkspace = lazy(() =>
  import('@/components/ssh/SSHWorkspace').then((m) => ({ default: m.SSHWorkspace }))
)

interface WorkspaceMainProps {
  isMobileWebShell: boolean
  isWorkspaceRoute: boolean
  projects: Project[]
  activeProject: Project | undefined
  ssh: SSHWorkspaceState
  setIsNewProjectModalOpen: (open: boolean) => void
  handleAddTerminal: (paneId: string | undefined, shell?: ShellInfo) => void
  handleNewBrowserTab: (paneId?: string) => void
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
  activeProject,
  ssh,
  setIsNewProjectModalOpen,
  handleAddTerminal,
  handleNewBrowserTab,
  handleCloseTerminal,
  handleCloseEditorTab,
  handleCloseTabs,
  closingTerminalIds
}: WorkspaceMainProps): React.JSX.Element {
  const { activeSSHProfile, sshProfileWithPassword, sshConn } = ssh
  const { renameTerminal } = useTerminalActions()
  const appDefaultShell = useDefaultShell()
  const paneRoot = usePaneRoot()
  const fullscreenPaneId = useFullscreenPaneId()
  const fullscreenPane = useMemo(() => {
    if (!fullscreenPaneId) return null
    const pane = findPaneById(paneRoot, fullscreenPaneId)
    return pane?.type === 'leaf' ? pane : null
  }, [fullscreenPaneId, paneRoot])
  // Mobile shell only: a split synced from desktop collapses to the active
  // leaf (read-only; null on desktop so the desktop node is unchanged).
  const mobileActiveLeaf = useMobileActiveLeaf(isMobileWebShell)

  return (
    <>
      {activeSSHProfile ? (
        <Suspense fallback={<ShellSkeleton />}>
          <SSHWorkspace profile={sshProfileWithPassword!} conn={sshConn} />
        </Suspense>
      ) : projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center bg-background px-6 rounded-xl">
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
              <motion.div
                key={fullscreenPaneId ? 'fullscreen' : 'normal'}
                initial={{ opacity: 0.85, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="h-full min-h-0 flex-1 overflow-hidden"
              >
                <PaneRenderer
                  key={mobileActiveLeaf?.id}
                  node={mobileActiveLeaf ?? fullscreenPane ?? paneRoot}
                  onAddTerminal={handleAddTerminal}
                  onAddBrowserTab={handleNewBrowserTab}
                  onCloseTerminal={handleCloseTerminal}
                  onRenameTerminal={renameTerminal}
                  onCloseEditorTab={handleCloseEditorTab}
                  onCloseTabs={handleCloseTabs}
                  closingTerminalIds={closingTerminalIds}
                  defaultShell={activeProject?.defaultShell || appDefaultShell}
                />
              </motion.div>
            </>
          ) : (
            <div className="relative flex-1 overflow-hidden bg-background rounded-xl">
              <div className="h-full w-full">
                <Outlet />
              </div>
            </div>
          )}
          {/* Story 11 (QA F9) put StatusBar on mobile; the mobile revamp
              retires it there as desktop chrome. Connection health now
              lives in the drawer footer. The last-command exit code has no
              mobile surface until the header goal's terminal sheet lands,
              and ContextBarSettingsPopover is not mounted on mobile. */}
          {!isMobileWebShell && <StatusBar project={activeProject} />}
        </>
      )}
    </>
  )
}
