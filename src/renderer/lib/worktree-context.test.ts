import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types/project'

const { projectStoreMock, ensureSymlinks, admitsWrites } = vi.hoisted(() => ({
  projectStoreMock: { getState: vi.fn() },
  ensureSymlinks: vi.fn(),
  admitsWrites: { value: true }
}))

vi.mock('@/lib/api', () => ({
  worktreeApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    branches: vi.fn(),
    ensureSymlinks,
    copyIncludeFiles: vi.fn()
  }
}))

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  serverAdmitsRemoteWrites: () => admitsWrites.value
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: projectStoreMock
}))

import { useShellLayoutStore } from '@/stores/shell-layout-store'
import {
  ensureWorktreeSymlinks,
  getActiveWorktreeForProject,
  getDefaultCwdForProject,
  getProjectRootPath
} from './worktree-context'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test',
    color: 'blue',
    path: '/projects/main',
    ...overrides
  } as Project
}

const WT_PATH = '/projects/main/.termul/worktrees/abc'
const WORKTREE = {
  id: 'wt-1',
  name: 'chat/abc',
  branch: 'chat/abc',
  path: WT_PATH,
  createdAt: '2026-01-01'
}

function setPick(path: string | null): void {
  useShellLayoutStore.setState({ worktreePickByProject: path === null ? {} : { p1: path } })
}

function setState(projects: Project[]): void {
  projectStoreMock.getState.mockReturnValue({ projects })
}

describe('worktree-context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPick(null)
    admitsWrites.value = true
  })

  describe('ensureWorktreeSymlinks', () => {
    beforeEach(() => {
      setState([
        makeProject({ isGitRepo: true, symlinkDirs: ['node_modules'], worktrees: [WORKTREE] })
      ])
      setPick(WT_PATH)
      ensureSymlinks.mockResolvedValue({ success: true, data: [] })
    })

    it('ensures the configured dirs in the active worktree', async () => {
      await ensureWorktreeSymlinks('p1')
      expect(ensureSymlinks).toHaveBeenCalledWith('/projects/main', WT_PATH, ['node_modules'])
    })

    it('sends nothing when the server refuses this client writes', async () => {
      admitsWrites.value = false
      await ensureWorktreeSymlinks('p1')
      expect(ensureSymlinks).not.toHaveBeenCalled()
    })
  })

  describe('getDefaultCwdForProject', () => {
    it('returns the main project root path', () => {
      setState([makeProject()])
      expect(getDefaultCwdForProject('p1')).toBe('/projects/main')
    })

    it('returns the project root even when an active worktree is set', () => {
      setState([
        makeProject({
          worktrees: [WORKTREE]
        })
      ])
      setPick(WT_PATH)
      expect(getDefaultCwdForProject('p1')).toBe('/projects/main')
    })

    it('returns the project root when there is no pick', () => {
      setState([makeProject()])
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
          worktrees: [WORKTREE]
        })
      ])
      setPick(WT_PATH)
      expect(getProjectRootPath('p1')).toBe('/projects/main')
    })
  })

  describe('active worktree derived from the shell-layout pick', () => {
    it('sees the picked worktree in any path form', () => {
      setState([makeProject({ worktrees: [WORKTREE] })])
      setPick(`${WT_PATH}/`)
      expect(getActiveWorktreeForProject('p1')).toEqual(WORKTREE)
    })

    it('sees the project folder with no pick', () => {
      setState([makeProject({ worktrees: [WORKTREE] })])
      expect(getActiveWorktreeForProject('p1')).toBeUndefined()
    })

    it('sees the project folder when the pick equals the project path', () => {
      setState([makeProject({ worktrees: [WORKTREE] })])
      setPick('/projects/main')
      expect(getActiveWorktreeForProject('p1')).toBeUndefined()
    })

    it('sees the project folder for a pruned pick', () => {
      setState([makeProject({ worktrees: [WORKTREE] })])
      setPick('/projects/main/.termul/worktrees/gone')
      expect(getActiveWorktreeForProject('p1')).toBeUndefined()
    })

    it('sees the project folder for a pick naming an outside-root worktree', () => {
      const project = makeProject({ worktrees: [{ ...WORKTREE, outsideProjectRoot: true }] })
      setState([project])
      setPick(WT_PATH)
      expect(getActiveWorktreeForProject('p1')).toBeUndefined()
    })

    it('sees nothing for a missing project', () => {
      setState([])
      setPick(WT_PATH)
      expect(getActiveWorktreeForProject('p1')).toBeUndefined()
    })
  })
})
