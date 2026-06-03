import { describe, expect, it } from 'vitest'
import type { Project } from '@/types/project'
import { filterProjects, PROJECT_SEARCH_THRESHOLD, shouldShowProjectSearch } from './project-filter'

const projects: Project[] = [
  {
    id: '1',
    name: 'Termul Desktop',
    color: 'blue',
    path: '/home/me/code/termul',
    gitBranch: 'main'
  },
  {
    id: '2',
    name: 'Landing Site',
    color: 'green',
    path: '/home/me/code/landing',
    gitBranch: 'feature/hero'
  },
  { id: '3', name: 'API Server', color: 'red', path: '/srv/api', gitBranch: 'develop' },
  { id: '4', name: 'Docs', color: 'gray' }
]

describe('filterProjects', () => {
  it('returns all projects when query is empty', () => {
    expect(filterProjects(projects, { searchQuery: '' })).toHaveLength(4)
  })

  it('returns all projects when query is only whitespace', () => {
    expect(filterProjects(projects, { searchQuery: '   ' })).toHaveLength(4)
  })

  it('returns all projects when searchQuery is undefined', () => {
    expect(filterProjects(projects, {})).toHaveLength(4)
  })

  it('matches on project name (case-insensitive)', () => {
    const result = filterProjects(projects, { searchQuery: 'termul' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('matches on path', () => {
    const result = filterProjects(projects, { searchQuery: '/srv/api' })
    expect(result.map((p) => p.id)).toEqual(['3'])
  })

  it('matches on git branch', () => {
    const result = filterProjects(projects, { searchQuery: 'feature/' })
    expect(result.map((p) => p.id)).toEqual(['2'])
  })

  it('trims surrounding whitespace before matching', () => {
    const result = filterProjects(projects, { searchQuery: '  docs  ' })
    expect(result.map((p) => p.id)).toEqual(['4'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterProjects(projects, { searchQuery: 'zzz-nope' })).toHaveLength(0)
  })

  it('does not throw for projects missing optional path/branch', () => {
    const result = filterProjects(projects, { searchQuery: 'docs' })
    expect(result.map((p) => p.id)).toEqual(['4'])
  })
})

describe('shouldShowProjectSearch', () => {
  it('hides search below the threshold', () => {
    expect(shouldShowProjectSearch(PROJECT_SEARCH_THRESHOLD - 1)).toBe(false)
  })

  it('shows search at the threshold', () => {
    expect(shouldShowProjectSearch(PROJECT_SEARCH_THRESHOLD)).toBe(true)
  })

  it('shows search above the threshold', () => {
    expect(shouldShowProjectSearch(PROJECT_SEARCH_THRESHOLD + 5)).toBe(true)
  })
})
