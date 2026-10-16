import { describe, expect, it } from 'vitest'
import type { Project, ProjectGroup } from '@/types/project'
import { layoutRailProjects, orderRailProjects } from './rail-project-order'

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id, color: 'blue', ...extra }) as Project
const group = (id: string, projectIds: string[]): ProjectGroup => ({ id, name: id, projectIds })
const names = (list: Project[]): string[] => list.map((p) => p.id)

describe('orderRailProjects', () => {
  it('keeps the list order when there are no groups', () => {
    expect(names(orderRailProjects([project('a'), project('b'), project('c')], []))).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('puts groups first (group order, then projectIds order), then the ungrouped', () => {
    const projects = ['a', 'b', 'c', 'd', 'e'].map((id) => project(id))
    const groups = [group('g1', ['e', 'c']), group('g2', ['b'])]
    expect(names(orderRailProjects(projects, groups))).toEqual(['e', 'c', 'b', 'a', 'd'])
  })

  it('skips archived and unknown projects', () => {
    const projects = [project('a'), project('b', { isArchived: true }), project('c')]
    expect(names(orderRailProjects(projects, [group('g', ['b', 'x', 'c'])]))).toEqual(['c', 'a'])
  })

  it('lists a project that sits in two groups once', () => {
    const projects = [project('a'), project('b')]
    const groups = [group('g1', ['a']), group('g2', ['a', 'b'])]
    expect(names(orderRailProjects(projects, groups))).toEqual(['a', 'b'])
  })
})

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
