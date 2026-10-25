/**
 * Per-project tree slice (AD-13): the flat `root/activePaneId/...` fields are
 * the ACTIVE project's tree; every other visited project's tree is parked in
 * `parkedTrees` under its id. Activating a project moves object references
 * between the two places — a visited tree is never cloned, re-parsed or
 * rebuilt on the way back.
 */

import type { StateCreator } from 'zustand'
import { createProjectWorkspace } from '../tree'
import type { ProjectWorkspace, WorkspaceState } from '../types'

type ProjectsSliceState = Pick<
  WorkspaceState,
  | 'activeProjectId'
  | 'parkedTrees'
  | 'activateProject'
  | 'hasProjectTree'
  | 'getProjectTree'
  | 'dropProjectTree'
>

function activeTreeOf(state: WorkspaceState): ProjectWorkspace {
  return {
    root: state.root,
    activePaneId: state.activePaneId,
    fullscreenPaneId: state.fullscreenPaneId,
    agentLauncherPaneId: state.agentLauncherPaneId,
    agentBrowserPaneId: state.agentBrowserPaneId
  }
}

export const createProjectsSlice: StateCreator<WorkspaceState, [], [], ProjectsSliceState> = (
  set,
  get
) => ({
  activeProjectId: '',
  parkedTrees: {},

  activateProject: (projectId: string, tree?: ProjectWorkspace): void => {
    const state = get()
    const parkedTrees = { ...state.parkedTrees }
    if (state.activeProjectId === projectId) {
      // Re-activating the visible project only ever swaps in an explicit tree.
      if (tree) set({ ...tree })
      return
    }
    if (state.activeProjectId) parkedTrees[state.activeProjectId] = activeTreeOf(state)
    const incoming = parkedTrees[projectId] ?? tree ?? createProjectWorkspace()
    delete parkedTrees[projectId]
    set({
      activeProjectId: projectId,
      parkedTrees,
      root: incoming.root,
      activePaneId: incoming.activePaneId,
      fullscreenPaneId: incoming.fullscreenPaneId,
      agentLauncherPaneId: incoming.agentLauncherPaneId,
      agentBrowserPaneId: incoming.agentBrowserPaneId
    })
  },

  hasProjectTree: (projectId: string): boolean =>
    get().activeProjectId === projectId || projectId in get().parkedTrees,

  getProjectTree: (projectId: string): ProjectWorkspace | undefined => {
    const state = get()
    if (state.activeProjectId === projectId) return activeTreeOf(state)
    return state.parkedTrees[projectId]
  },

  dropProjectTree: (projectId: string): void => {
    if (!(projectId in get().parkedTrees)) return
    set((state) => {
      const { [projectId]: _dropped, ...rest } = state.parkedTrees
      return { parkedTrees: rest }
    })
  }
})
