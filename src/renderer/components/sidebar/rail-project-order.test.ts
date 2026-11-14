import { describe, expect, it } from 'vitest'
import type { Project, ProjectGroup } from '@/types/project'
import { layoutRailProjects } from './rail-project-order'

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id, color: 'blue', ...extra }) as Project
const group = (id: string, projectIds: string[]): ProjectGroup => ({ id, name: id, projectIds })
const names = (list: Project[]): string[] => list.map((p) => p.id)

describe('layoutRailProjects', () => {
  it('splits open projects into groups and the ungrouped, in list order', () => {
    const projects = ['a', 'b', 'c'].map((id) => project(id))
    const layout = layoutRailProjects(projects, [group('g', ['c']), group('empty', [])])
    expect(layout.groups.map((entry) => [entry.group.id, names(entry.projects)])).toEqual([
      ['g', ['c']],
      ['empty', []]
    ])
    expect(names(layout.ungrouped)).toEqual(['a', 'b'])
  })
})
