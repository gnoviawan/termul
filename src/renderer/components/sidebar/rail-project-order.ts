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
 * Splits the open (not archived) projects the way the expanded Rail lists
 * them: by group first, then the ungrouped ones. The collapsed Rail reads the
 * same split through {@link orderRailProjects}, so both show one order.
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

/**
 * Open projects as one flat list in the expanded Rail's order: group order,
 * then each group's `projectIds`, then the ungrouped ones. A project listed in
 * two groups appears once, at its first place.
 */
export function orderRailProjects(
  projects: readonly Project[],
  groups: readonly ProjectGroup[]
): Project[] {
  const { groups: railGroups, ungrouped } = layoutRailProjects(projects, groups)
  const seen = new Set<string>()
  const ordered: Project[] = []
  for (const project of [...railGroups.flatMap((entry) => entry.projects), ...ungrouped]) {
    if (seen.has(project.id)) continue
    seen.add(project.id)
    ordered.push(project)
  }
  return ordered
}
