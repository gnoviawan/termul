import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { lazy, Suspense } from 'react'
import {
  FileExplorerToggleButton,
  panelEdgeToggleButtonClass
} from '@/components/TitlebarPanelToggles'
import { edgeToggleMotion, panelRevealMotion } from '@/layouts/workspace-layout/panel-motion'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import type { Project } from '@/types/project'

const FileExplorer = lazy(() =>
  import('@/components/file-explorer/FileExplorer').then((m) => ({ default: m.FileExplorer }))
)
const SSHFileExplorer = lazy(() =>
  import('@/components/ssh/SSHFileExplorer').then((m) => ({ default: m.SSHFileExplorer }))
)

interface ExplorerColumnProps {
  activeProject: Project | undefined
  ssh: SSHWorkspaceState
}

/**
 * File Explorer. The whole column (explorer + SSH block)
 * width-reveals together; each inner block also reveals
 * on its own — toggling the explorer or connecting SSH
 * animates instead of shifting layout.
 */
export function ExplorerColumn({ activeProject, ssh }: ExplorerColumnProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const isExplorerVisible = useFileExplorerVisible()
  const {
    activeSSHProfile,
    sshConn,
    handleSSHMkdir,
    handleSSHCreateFile,
    handleSSHDelete,
    handleSSHRename
  } = ssh

  return (
    <AnimatePresence initial={false}>
      {(isExplorerVisible && activeProject?.path) || activeSSHProfile ? (
        <motion.div
          key="explorer-column"
          className="flex-shrink-0 h-full overflow-hidden"
          {...panelRevealMotion(reducedMotion)}
        >
          <div className="flex h-full flex-col gap-2">
            <AnimatePresence initial={false}>
              {isExplorerVisible && activeProject?.path && (
                <motion.div
                  key="file-explorer-panel"
                  className={cn('overflow-hidden', activeSSHProfile ? 'flex-1 min-h-0' : 'h-full')}
                  {...panelRevealMotion(reducedMotion)}
                >
                  <Suspense fallback={<ShellSkeleton />}>
                    <FileExplorer side="right" />
                  </Suspense>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {activeSSHProfile && (
                <motion.div
                  key="ssh-explorer-panel"
                  className="flex-1 min-h-0 overflow-hidden"
                  {...panelRevealMotion(reducedMotion)}
                >
                  <div
                    className={cn(
                      'h-full bg-background rounded-xl overflow-hidden flex flex-col border border-border',
                      !(isExplorerVisible && activeProject?.path) && 'w-64'
                    )}
                  >
                    <Suspense fallback={<ShellSkeleton />}>
                      <SSHFileExplorer
                        connectionId={sshConn.connectionId ?? ''}
                        isConnected={sshConn.isConnected}
                        sftpReady={sshConn.sftpReady}
                        entries={sshConn.entries}
                        currentPath={sshConn.currentPath}
                        expandedDirs={sshConn.expandedDirs}
                        childEntries={sshConn.childEntries}
                        loadingDirs={sshConn.loadingDirs}
                        isLoadingRoot={sshConn.isLoadingRoot}
                        profileName={activeSSHProfile.name}
                        onConnect={sshConn.handleConnect}
                        onBrowseFiles={sshConn.handleBrowseFiles}
                        onToggleDir={sshConn.toggleDirectory}
                        onLoadDir={sshConn.loadDirectory}
                        onMkdir={handleSSHMkdir}
                        onCreateFile={handleSSHCreateFile}
                        onDelete={handleSSHDelete}
                        onRename={handleSSHRename}
                      />
                    </Suspense>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      ) : (
        !isExplorerVisible &&
        activeProject?.path &&
        !isTauriContext() && (
          // Web-only slim edge toggle so a hidden file explorer
          // stays re-openable. Desktop re-opens via the
          // TitleBar. Its enter is deferred until the column's
          // collapse exits (edgeToggleMotion).
          <motion.div
            key="explorer-edge-toggle"
            className="flex-shrink-0 flex items-start overflow-hidden"
            {...edgeToggleMotion(reducedMotion)}
          >
            <FileExplorerToggleButton className={panelEdgeToggleButtonClass} />
          </motion.div>
        )
      )}
    </AnimatePresence>
  )
}
