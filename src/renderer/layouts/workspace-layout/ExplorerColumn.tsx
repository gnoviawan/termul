import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { lazy, type ReactNode, Suspense } from 'react'
import { SidePanelHeader, useWindowControlsInPanel } from '@/components/shell/SidePanelHeader'
import { useSidePanelResize } from '@/components/shell/use-side-panel-resize'
import { getExplorerColumnBlocks } from '@/layouts/workspace-layout/explorer-column-blocks'
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
   * The project's panel body (`SidePanelColumn`). Not rendered while the SSH
   * workspace is open: the remote file browser then fills the panel.
   */
  sidePanel: ReactNode
}

/**
 * Right panel (Paper "Side panel"), between the main area and the tool
 * strip: 0.5px start hairline, persisted width (340 by default), resized
 * from its left edge. It shows the project panel, or the remote file browser
 * of the connected SSH session, and width-reveals when it opens or closes.
 */
export function ExplorerColumn({
  activeProject,
  ssh,
  sidePanel
}: ExplorerColumnProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const isExplorerVisible = useFileExplorerVisible()
  const { width, min, max, onResizeMouseDown, onResizeKeyDown } = useSidePanelResize()
  const { activeSSHProfile } = ssh
  // Windows/Linux: the remote file browser has no top row header of its own,
  // so it gets one to end with the window controls spacer.
  const controlsInPanel = useWindowControlsInPanel()
  const { showFileColumn, sftpSession } = getExplorerColumnBlocks({
    isExplorerVisible,
    activeProject,
    ssh,
    hasSidePanel: Boolean(sidePanel)
  })

  const content = sftpSession ? (
    <>
      {controlsInPanel && <SidePanelHeader title="Remote files" />}
      <div className="min-h-0 flex-1">
        <SSHFileExplorer
          key={sftpSession.attemptId}
          connectionId={sftpSession.attemptId}
          profileName={activeSSHProfile?.name ?? 'host'}
        />
      </div>
    </>
  ) : showFileColumn ? (
    sidePanel
  ) : null

  return (
    <AnimatePresence initial={false}>
      {content ? (
        <motion.div
          key="right-panel"
          className="h-full flex-shrink-0 overflow-hidden"
          {...panelRevealMotion(reducedMotion)}
        >
          <aside
            aria-label="Side panel"
            data-testid="right-panel"
            className="relative flex h-full flex-col overflow-hidden border-l-[0.5px] border-border bg-background text-foreground"
            style={{ width }}
          >
            <Suspense fallback={<ShellSkeleton />}>{content}</Suspense>
            <button
              type="button"
              onMouseDown={onResizeMouseDown}
              onKeyDown={onResizeKeyDown}
              className={cn(
                'absolute top-0 left-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent focus-visible:outline-none',
                // 1px indicator on the panel's start hairline.
                'after:absolute after:inset-y-0 after:left-0 after:w-px after:bg-transparent after:transition-colors after:duration-150 after:ease-out',
                'hover:after:bg-muted-foreground/40 focus-visible:after:bg-muted-foreground/60 active:after:bg-muted-foreground/60'
              )}
              title="Drag to resize side panel"
              aria-label="Resize side panel"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={width}
              aria-valuemin={min}
              aria-valuemax={max}
            />
          </aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
