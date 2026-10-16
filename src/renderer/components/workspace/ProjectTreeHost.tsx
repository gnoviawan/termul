import type { ShellInfo } from '@shared/types/ipc.types'
import { motion } from 'framer-motion'
import { memo, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { findPaneById, useWorkspaceStore, type WorkspaceTab } from '@/stores/workspace-store'
import { ProjectPaneContext, selectProjectTree } from '@/stores/workspace-store/pane-context'
import type { LeafNode } from '@/types/workspace.types'
import { PaneRenderer } from './PaneRenderer'

export interface ProjectTreeHostProps {
  /** Project whose tree this host renders ('' = the pre-first-commit active tree). */
  projectId: string
  /** True for the one visible tree; every other host stays mounted but hidden. */
  isActiveProject: boolean
  /** Mobile shell only: render this leaf instead of the whole tree (active host only). */
  leafOverride?: LeafNode | null
  onAddTerminal?: (paneId: string, shell?: ShellInfo) => void
  onAddBrowserTab?: (paneId: string) => void
  onCloseTerminal?: (id: string, tabId: string) => void
  onRenameTerminal?: (id: string, name: string) => void
  onCloseEditorTab?: (filePath: string) => void
  onCloseTabs?: (tabs: WorkspaceTab[]) => void
  closingTerminalIds?: string[]
  defaultShell?: string
}

/**
 * Hidden hosts keep layout (xterm needs a non-zero size to fit) but are
 * invisible, unclickable and out of the tab order / accessibility tree.
 */
const HIDDEN_HOST_CLASS = 'absolute inset-0 invisible pointer-events-none'
const HIDDEN_HOST_ATTRS = { 'aria-hidden': true, inert: '' } as const

/**
 * Ids of the projects whose trees stay mounted: the active one plus every
 * parked one, ordered by first visit. The order never reshuffles on a switch
 * (a keyed DOM move would reload iframes/webviews inside a tree); a project
 * whose tree was dropped simply leaves the list.
 */
export function useMountedProjectIds(): string[] {
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId)
  const parkedIds = useWorkspaceStore(useShallow((state) => Object.keys(state.parkedTrees)))
  const orderRef = useRef<string[]>([])
  const live = [activeProjectId, ...parkedIds]
  const ordered = orderRef.current.filter((id) => live.includes(id))
  for (const id of live) if (!ordered.includes(id)) ordered.push(id)
  orderRef.current = ordered
  return ordered
}

/**
 * One project's pane tree, kept mounted across project switches (AD-13): the
 * panels inside keep their xterm instances, chat state and webviews while the
 * project is hidden. Every tree component reads this project's tree through
 * `ProjectPaneContext`, and a hidden host's panels render with `isVisible=false`.
 */
function ProjectTreeHostView({
  projectId,
  isActiveProject,
  leafOverride,
  ...rendererProps
}: ProjectTreeHostProps): React.JSX.Element {
  const root = useWorkspaceStore((state) => selectProjectTree(state, projectId).root)
  const fullscreenPaneId = useWorkspaceStore(
    (state) => selectProjectTree(state, projectId).fullscreenPaneId
  )
  const fullscreenPane = useMemo(() => {
    if (!fullscreenPaneId) return null
    const pane = findPaneById(root, fullscreenPaneId)
    return pane?.type === 'leaf' ? pane : null
  }, [fullscreenPaneId, root])
  const contextValue = useMemo(() => ({ projectId, isActiveProject }), [projectId, isActiveProject])

  return (
    <ProjectPaneContext.Provider value={contextValue}>
      <div
        data-project-tree={projectId}
        data-project-tree-state={isActiveProject ? 'active' : 'hidden'}
        className={isActiveProject ? 'h-full w-full' : HIDDEN_HOST_CLASS}
        {...(isActiveProject ? {} : HIDDEN_HOST_ATTRS)}
      >
        <motion.div
          key={fullscreenPaneId ? 'fullscreen' : 'normal'}
          initial={{ opacity: 0.85, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="h-full min-h-0 flex-1 overflow-hidden"
        >
          <PaneRenderer
            key={leafOverride?.id}
            node={leafOverride ?? fullscreenPane ?? root}
            {...rendererProps}
          />
        </motion.div>
      </div>
    </ProjectPaneContext.Provider>
  )
}

/**
 * Notify gate: while a host is hidden, parent re-renders (callback identity,
 * layout state) are ignored — it re-renders only when its own tree changes
 * through the store, and takes the fresh props the moment it becomes active.
 */
export const ProjectTreeHost = memo(
  ProjectTreeHostView,
  (prev, next) =>
    !prev.isActiveProject &&
    !next.isActiveProject &&
    prev.projectId === next.projectId &&
    prev.defaultShell === next.defaultShell
)
