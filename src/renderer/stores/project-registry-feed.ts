/**
 * Feeds the project store from the host's `projects` watch — the only way the
 * list reaches the store, on the browser and the desktop alike.
 *
 * A watch state replaces the store's list wholesale. What the host does not
 * carry (icon, git state, worktrees, shell, env vars, groups, order) is carried
 * over: from the store's current project when it is already listed, else from
 * the renderer-owned prefs the device saved.
 *
 * Which project is active is this device's choice, never the host's: the saved
 * selection on the first state, the current one afterwards, and only when that
 * project is gone the host default, else the first project that is not archived.
 */

import type { ProjectListPayload, ProjectSummary } from '@shared/types/web-projects.types'
import {
  type ClientProjectFields,
  clientFieldsOf,
  getProjectLayout,
  getProjectPrefs
} from '@/lib/project-prefs'
import { clearChatRoute } from '@/lib/router-navigate'
import type { Project, ProjectColor } from '@/types/project'
import { useProjectStore } from './project-store'

function summaryToProject(summary: ProjectSummary): Project {
  return {
    id: summary.id,
    name: summary.name,
    color: summary.color as ProjectColor,
    path: summary.path ?? undefined,
    isArchived: summary.isArchived,
    isDefault: summary.isDefault
  }
}

function definedFields(fields: ClientProjectFields): ClientProjectFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as ClientProjectFields
}

/**
 * The store's projects for a watch state: host fields from the summaries, in
 * the order the device last used (ids it has not seen yet follow, in host
 * order), client-only fields carried over.
 */
export function buildProjectsFromRegistry(
  list: ProjectListPayload,
  previous: Project[],
  order: string[]
): Project[] {
  const previousById = new Map(previous.map((project) => [project.id, project]))
  const rank = new Map(order.map((id, index) => [id, index]))
  return list.projects
    .map((summary) => {
      const live = previousById.get(summary.id)
      const carried = live ? clientFieldsOf(live) : getProjectPrefs(summary.id)
      return { ...summaryToProject(summary), ...(carried ? definedFields(carried) : {}) }
    })
    .sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length))
}

/**
 * The project to be active for `projects`: `preferred` when it is listed, else
 * the host default, else the first project that is not archived, else the
 * first, else `''`.
 */
export function pickActiveProjectId(
  projects: Project[],
  preferred: string | null,
  defaultProjectId: string | null
): string {
  const listed = (id: string | null): id is string =>
    id !== null && projects.some((project) => project.id === id)
  if (listed(preferred)) return preferred
  if (listed(defaultProjectId)) return defaultProjectId
  return (projects.find((project) => !project.isArchived) ?? projects[0])?.id ?? ''
}

/**
 * Replace the store's content with a watch state. `savedActiveProjectId` is
 * this device's saved selection; only the first state (the store not yet
 * loaded) reads it. Returns the id that is active afterwards.
 */
export function applyRegistryList(
  list: ProjectListPayload,
  savedActiveProjectId: string | null
): string {
  const state = useProjectStore.getState()
  const layout = getProjectLayout()
  const projects = buildProjectsFromRegistry(
    list,
    state.projects,
    state.isLoaded ? state.projects.map((project) => project.id) : layout.order
  )
  // A saved selection that was archived elsewhere is not a place to land.
  const savedUsable = projects.some((p) => p.id === savedActiveProjectId && !p.isArchived)
  const preferred = state.isLoaded
    ? state.activeProjectId
    : savedUsable
      ? savedActiveProjectId
      : null
  const activeProjectId = pickActiveProjectId(projects, preferred, list.defaultProjectId)
  // Groups created before the first list landed stay; the saved ones fill in the rest.
  const groups = state.isLoaded
    ? state.groups
    : [
        ...layout.groups.filter(
          (layoutGroup) => !state.groups.some((group) => group.id === layoutGroup.id)
        ),
        ...state.groups
      ]
  state.setProjects(projects, activeProjectId, groups)
  // The project this device was on is gone: leave its chat route.
  if (state.isLoaded && activeProjectId !== state.activeProjectId) clearChatRoute()
  return activeProjectId
}
