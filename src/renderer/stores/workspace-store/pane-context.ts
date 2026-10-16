/**
 * Which project's pane tree a component is rendered inside (AD-13: every
 * visited project's tree stays mounted, only the active one visible).
 *
 * `ProjectTreeHost` provides the value. Without a provider (unit tests, any
 * surface rendering a single tree) a component belongs to the ACTIVE project,
 * so the flat workspace fields are its tree.
 */

import { createContext, useContext } from 'react'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { createProjectWorkspace } from './tree'
import type { ProjectWorkspace, WorkspaceState } from './types'

export interface ProjectPaneContextValue {
  /** The project whose tree this subtree renders ('' = the pre-first-commit active tree). */
  projectId: string
  /** False while another project is on screen: this tree is mounted but hidden. */
  isActiveProject: boolean
}

export const ProjectPaneContext = createContext<ProjectPaneContextValue | null>(null)

/** The enclosing host's project, or null outside any `ProjectTreeHost`. */
export function useProjectPaneContext(): ProjectPaneContextValue | null {
  return useContext(ProjectPaneContext)
}

/** True when the enclosing tree is the visible one (always true outside a host). */
export function useIsPaneProjectActive(): boolean {
  return useContext(ProjectPaneContext)?.isActiveProject ?? true
}

/**
 * Tree of `projectId` for a tree-internal selector: the flat fields (the state
 * itself, structurally a `ProjectWorkspace`) when that project is active or no
 * project is named, else its parked tree. A tree dropped under a still-mounted
 * host reads an empty workspace until the host unmounts.
 */
export function selectProjectTree(
  state: WorkspaceState,
  projectId: string | null | undefined
): ProjectWorkspace {
  if (projectId == null || projectId === state.activeProjectId) return state
  return state.parkedTrees[projectId] ?? DETACHED_TREE
}

const DETACHED_TREE: ProjectWorkspace = createProjectWorkspace()

/**
 * Select from the pane tree of the enclosing `ProjectTreeHost`'s project. In
 * the active project that is the flat fields; in a hidden project it is the
 * parked tree, so a hidden host never re-renders for the active project's
 * tree changes. Outside any host this is the active tree.
 */
export function usePaneTree<T>(selector: (tree: ProjectWorkspace) => T): T {
  const projectId = useProjectPaneContext()?.projectId
  return useWorkspaceStore((state) => selector(selectProjectTree(state, projectId)))
}
