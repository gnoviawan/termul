import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types/project'

const { projectStoreMock } = vi.hoisted(() => ({
  projectStoreMock: { getState: vi.fn() }
}))

// worktree-context.ts imports worktreeApi at module load; the mock prevents
// the real API from firing during tests. The tested functions don't call it,
// but the import binding must resolve.
vi.mock('@/lib/api', () => ({
  worktreeApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    branches: vi.fn(),
    ensureSymlinks: vi.fn(),
    copyIncludeFiles: vi.fn()
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: projectStoreMock
}))

import { getDefaultCwdForProject, getProjectRootPath } from './worktree-context'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test',
    color: 'blue',
    path: '/projects/main',
    ...overrides
  } as Project
}

function setState(projects: Project[]): void {
  projectStoreMock.getState.mockReturnValue({ projects })
}

describe('worktree-context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getDefaultCwdForProject', () => {
    it('returns the main project root path', () => {
      setState([makeProject()])
      expect(getDefaultCwdForProject('p1')).toBe('/projects/main')
    })

    it('returns the project root even when an active worktree is set', () => {
      setState([
        makeProject({
          activeWorktreeId: 'wt-1',
          worktrees: [
            {
              id: 'wt-1',
              name: 'chat/abc',
              branch: 'chat/abc',
              path: '/projects/main/.termul/worktrees/abc',
              createdAt: '2026-01-01'
            }
          ]
        })
      ])
      expect(getDefaultCwdForProject('p1')).toBe('/projects/main')
    })

    it('returns the project root when activeWorktreeId is null', () => {
      setState([makeProject({ activeWorktreeId: null })])
      expect(getDefaultCwdForProject('p1')).toBe('/projects/main')
    })

    it('returns empty string when the project is not found', () => {
      setState([])
      expect(getDefaultCwdForProject('missing')).toBe('')
    })

    it('returns empty string when the project has no path', () => {
      setState([makeProject({ path: '' })])
      expect(getDefaultCwdForProject('p1')).toBe('')
    })

    it('returns empty string when project.path is undefined (optional field)', () => {
      setState([makeProject({ path: undefined })])
      expect(getDefaultCwdForProject('p1')).toBe('')
    })
  })

  describe('getProjectRootPath', () => {
    it('returns the main project root path regardless of active worktree', () => {
      setState([
        makeProject({
          activeWorktreeId: 'wt-1',
          worktrees: [
            {
              id: 'wt-1',
              name: 'chat/abc',
              branch: 'chat/abc',
              path: '/projects/main/.termul/worktrees/abc',
              createdAt: '2026-01-01'
            }
          ]
        })
      ])
      expect(getProjectRootPath('p1')).toBe('/projects/main')
    })
  })
})
