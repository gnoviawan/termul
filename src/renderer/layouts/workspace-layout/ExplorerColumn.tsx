import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { lazy, type ReactNode, Suspense } from 'react'
import { panelRevealMotion } from '@/layouts/workspace-layout/panel-motion'
import { ShellSkeleton } from '@/layouts/workspace-layout/ShellSkeleton'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { cn } from '@/lib/utils'
import { useFileExplorerVisible } from '@/stores/file-explorer-store'
import type { Project } from '@/types/project'

const SSHFileExplorer = lazy(() =>
  import('@/components/ssh/SSHFileExplorer').then((m) => ({ default: m.SSHFileExplorer }))
)

interface ExplorerColumnProps {
  activeProject: Project | undefined
  ssh: SSHWorkspaceState
  /**
   * Shell Side panel that fills the file column. Not rendered while the SSH
   * workspace is open: the remote file browser then stands alone.
   */
  sidePanel: ReactNode
}

/**
 * Side panel column. The whole column (file panel + SSH block)
 * width-reveals together; each inner block also reveals
 * on its own — toggling the explorer or connecting SSH
 * animates instead of shifting layout.
 */
export function ExplorerColumn({
  activeProject,
  ssh,
  sidePanel
}: ExplorerColumnProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const isExplorerVisible = useFileExplorerVisible()
  const { workspaceOpen, activeSSHProfile, activeSSHSession } = ssh
  const showFileColumn = Boolean(
    isExplorerVisible && activeProject?.path && !(sidePanel && workspaceOpen)
  )
  // Remote files of the active, connected session tab.
  const sftpSession =
    workspaceOpen && isExplorerVisible && activeSSHSession?.status === 'connected'
      ? activeSSHSession
      : null

  return (
    <AnimatePresence initial={false}>
      {showFileColumn || sftpSession ? (
        <motion.div
          key="explorer-column"
          className="flex-shrink-0 h-full overflow-hidden"
          {...panelRevealMotion(reducedMotion)}
        >
          <div className="flex h-full flex-col gap-2">
            <AnimatePresence initial={false}>
              {showFileColumn && (
                <motion.div
                  key="file-explorer-panel"
                  className={cn('overflow-hidden', sftpSession ? 'flex-1 min-h-0' : 'h-full')}
                  {...panelRevealMotion(reducedMotion)}
                >
                  <Suspense fallback={<ShellSkeleton />}>{sidePanel}</Suspense>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {sftpSession && (
                <motion.div
                  key="ssh-explorer-panel"
                  className="flex-1 min-h-0 overflow-hidden"
                  {...panelRevealMotion(reducedMotion)}
                >
                  <div
                    className={cn(
                      'h-full bg-background rounded-xl overflow-hidden flex flex-col border border-border',
                      !showFileColumn && 'w-80',
                      // Revamped frame: no gap before the main card, so keep the gutter here.
                      sidePanel && !showFileColumn && 'mr-2'
                    )}
                  >
                    <Suspense fallback={<ShellSkeleton />}>
                      <SSHFileExplorer
                        key={sftpSession.attemptId}
                        connectionId={sftpSession.attemptId}
                        profileName={activeSSHProfile?.name ?? 'host'}
                      />
                    </Suspense>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
