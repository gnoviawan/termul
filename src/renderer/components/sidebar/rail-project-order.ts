import type { Project, ProjectGroup } from '@/types/project'

export interface RailProjectGroup {
  group: ProjectGroup
  projects: Project[]
}

export interface RailProjectLayout {
  /** Groups in group order, each with its open projects in `projectIds` order. */
  groups: RailProjectGroup[]
  /** Open projects that belong to no group, in list order. */
  ungrouped: Project[]
}

/**
 * Splits the open (not archived) projects the way the Rail lists them (both
 * densities): by group first, then the ungrouped ones.
 */
export function layoutRailProjects(
  projects: readonly Project[],
  groups: readonly ProjectGroup[]
): RailProjectLayout {
  const open = projects.filter((project) => !project.isArchived)
  const byId = new Map(open.map((project) => [project.id, project]))
  const grouped = new Set<string>()
  const railGroups = groups.map((group) => {
    const inGroup: Project[] = []
    for (const projectId of group.projectIds) {
      const project = byId.get(projectId)
      if (project) inGroup.push(project)
      grouped.add(projectId)
    }
    return { group, projects: inGroup }
  })
  return { groups: railGroups, ungrouped: open.filter((project) => !grouped.has(project.id)) }
}
