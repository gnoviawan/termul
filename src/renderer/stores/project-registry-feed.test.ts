import type { ProjectPrefsRecord } from '@shared/types/persistence.types'
import type { ProjectListPayload, ProjectSummary } from '@shared/types/web-projects.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { persisted, clearChatRoute } = vi.hoisted(() => ({
  persisted: { record: null as ProjectPrefsRecord | null },
  clearChatRoute: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(async () =>
      persisted.record
        ? { success: true, data: persisted.record }
        : { success: false, code: 'KEY_NOT_FOUND', error: 'none' }
    ),
    write: vi.fn(),
    writeDebounced: vi.fn()
  },
  secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() }
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => false }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/active-project', () => ({ writeActiveProject: vi.fn() }))
vi.mock('@/lib/project-registry-api', () => ({
  ProjectBusyError: class extends Error {},
  projectRegistryApi: {}
}))
vi.mock('@/lib/router-navigate', () => ({ clearChatRoute }))

import { _resetProjectPrefsForTests, loadProjectPrefs } from '@/lib/project-prefs'
import {
  applyRegistryList,
  buildProjectsFromRegistry,
  pickActiveProjectId
} from './project-registry-feed'
import { useProjectStore } from './project-store'

function summary(id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    name: `Project ${id}`,
    color: 'blue',
    path: `/work/${id}`,
    isArchived: false,
    isDefault: false,
    ...extra
  }
}

function list(
  projects: ProjectSummary[],
  defaultProjectId: string | null = null
): ProjectListPayload {
  return { projects, defaultProjectId }
}

function prefsRecord(overrides: Partial<ProjectPrefsRecord>): ProjectPrefsRecord {
  return {
    projects: {},
    groups: [],
    order: [],
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  persisted.record = null
  _resetProjectPrefsForTests()
  useProjectStore.setState({ projects: [], groups: [], activeProjectId: '', isLoaded: false })
  await loadProjectPrefs()
})

describe('applyRegistryList', () => {
  it('replaces the store content with the host list and loads the store', () => {
    useProjectStore.setState({
      projects: [{ id: 'stale', name: 'Stale', color: 'red' }],
      activeProjectId: 'stale',
      isLoaded: true
    })

    applyRegistryList(list([summary('a'), summary('b')]), null)

    const state = useProjectStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['a', 'b'])
    expect(state.isLoaded).toBe(true)
  })

  it('stamps the host default from the summaries, not from navigation', () => {
    applyRegistryList(list([summary('a'), summary('b', { isDefault: true })], 'b'), 'a')

    const state = useProjectStore.getState()
    expect(state.projects.find((p) => p.id === 'b')?.isDefault).toBe(true)
    expect(state.projects.find((p) => p.id === 'a')?.isDefault).toBe(false)
    expect(state.activeProjectId).toBe('a')
  })

  describe('client-only fields', () => {
    it('carries them over from the project already in the store', () => {
      const icon = { dataUri: 'data:image/png;base64,AA==', fetchedAt: 1 }
      applyRegistryList(list([summary('a')]), null)
      useProjectStore.getState().updateProject('a', {
        icon: icon as never,
        isGitRepo: true,
        gitBranch: 'feature',
        defaultShell: '/bin/zsh',
        worktrees: [{ id: 'w', name: 'w', branch: 'x', path: '/work/a-w', createdAt: 't' }],
        symlinkDirs: ['node_modules']
      })

      applyRegistryList(list([summary('a', { name: 'Renamed' })]), null)

      expect(useProjectStore.getState().projects[0]).toMatchObject({
        name: 'Renamed',
        icon,
        isGitRepo: true,
        gitBranch: 'feature',
        defaultShell: '/bin/zsh',
        worktrees: [{ id: 'w' }],
        symlinkDirs: ['node_modules']
      })
    })

    it('reads them from the saved prefs for a project the store has not listed yet', async () => {
      persisted.record = prefsRecord({
        projects: {
          a: {
            gitBranch: 'main',
            defaultShell: '/bin/fish',
            isGitRepo: true,
            symlinkDirs: ['dist']
          }
        }
      })
      await loadProjectPrefs()

      applyRegistryList(list([summary('a'), summary('other')]), null)

      const [a, other] = useProjectStore.getState().projects
      expect(a).toMatchObject({ gitBranch: 'main', defaultShell: '/bin/fish', isGitRepo: true })
      expect(a.symlinkDirs).toEqual(['dist'])
      expect(other.gitBranch).toBeUndefined()
    })

    it('drops them with the project when the host no longer lists it', () => {
      applyRegistryList(list([summary('a'), summary('b')]), null)
      useProjectStore.getState().updateProject('b', { gitBranch: 'dev' })

      applyRegistryList(list([summary('a')]), null)

      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['a'])
    })
  })

  describe('order and groups', () => {
    it('lists the saved order on the first state, new ids after it in host order', async () => {
      persisted.record = prefsRecord({ order: ['c', 'a'] })
      await loadProjectPrefs()

      applyRegistryList(list([summary('a'), summary('b'), summary('c'), summary('d')]), null)

      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['c', 'a', 'b', 'd'])
    })

    it('keeps the order the user gave afterwards, adding new projects at the end', () => {
      applyRegistryList(list([summary('a'), summary('b')]), null)
      useProjectStore.getState().reorderProjects(['b', 'a'])

      applyRegistryList(list([summary('a'), summary('b'), summary('c')]), null)

      expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['b', 'a', 'c'])
    })

    it('restores the saved groups on the first state and keeps the live ones afterwards', async () => {
      persisted.record = prefsRecord({
        groups: [{ id: 'g', name: 'Saved', projectIds: ['a'] }]
      })
      await loadProjectPrefs()

      applyRegistryList(list([summary('a')]), null)
      expect(useProjectStore.getState().groups.map((g) => g.name)).toEqual(['Saved'])

      useProjectStore.getState().renameGroup('g', 'Renamed')
      applyRegistryList(list([summary('a'), summary('b')]), null)
      expect(useProjectStore.getState().groups.map((g) => g.name)).toEqual(['Renamed'])
    })

    it('keeps a group created before the first state, next to the saved ones', async () => {
      persisted.record = prefsRecord({
        groups: [{ id: 'g', name: 'Saved', projectIds: ['a'] }]
      })
      await loadProjectPrefs()
      useProjectStore.setState({
        groups: [{ id: 'new', name: 'Created early', projectIds: [] }]
      })

      applyRegistryList(list([summary('a')]), null)

      expect(useProjectStore.getState().groups.map((g) => g.name)).toEqual([
        'Saved',
        'Created early'
      ])
    })
  })

  describe('active project', () => {
    it('lands on this device saved selection when the host lists it', () => {
      applyRegistryList(list([summary('a'), summary('b')], 'a'), 'b')

      expect(useProjectStore.getState().activeProjectId).toBe('b')
    })

    it('lands on the host default when the device has no saved selection', () => {
      applyRegistryList(list([summary('a'), summary('b')], 'b'), null)

      expect(useProjectStore.getState().activeProjectId).toBe('b')
    })

    it('lands on the host default when the saved selection is gone or archived', () => {
      applyRegistryList(
        list([summary('a'), summary('b', { isArchived: true }), summary('c')], 'c'),
        'b'
      )
      expect(useProjectStore.getState().activeProjectId).toBe('c')

      useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: false })
      applyRegistryList(list([summary('a'), summary('c')], 'c'), 'removed-elsewhere')
      expect(useProjectStore.getState().activeProjectId).toBe('c')
    })

    it('lands on the first project that is not archived when there is no usable default', () => {
      applyRegistryList(
        list([summary('x', { isArchived: true }), summary('y'), summary('z')], null),
        null
      )
      expect(useProjectStore.getState().activeProjectId).toBe('y')

      useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: false })
      applyRegistryList(list([summary('y'), summary('z')], 'dangling'), null)
      expect(useProjectStore.getState().activeProjectId).toBe('y')
    })

    it('keeps this device selection when the host default moves', () => {
      applyRegistryList(list([summary('a'), summary('b')], 'a'), null)
      useProjectStore.getState().selectProject('b')
      clearChatRoute.mockClear()

      applyRegistryList(list([summary('a'), summary('b')], 'a'), null)
      applyRegistryList(list([summary('a'), summary('b')], 'b'), null)

      expect(useProjectStore.getState().activeProjectId).toBe('b')
      expect(clearChatRoute).not.toHaveBeenCalled()
    })

    it('falls back to the host default and leaves the chat route when the active project is removed', () => {
      applyRegistryList(list([summary('a'), summary('b')], 'a'), 'b')
      expect(useProjectStore.getState().activeProjectId).toBe('b')

      applyRegistryList(list([summary('a')], 'a'), null)

      expect(useProjectStore.getState().activeProjectId).toBe('a')
      expect(clearChatRoute).toHaveBeenCalled()
    })

    it('has no active project when the host has no projects', () => {
      applyRegistryList(list([], null), 'a')

      expect(useProjectStore.getState().activeProjectId).toBe('')
      expect(useProjectStore.getState().isLoaded).toBe(true)
    })
  })
})

describe('pickActiveProjectId', () => {
  const projects = [
    { id: 'a', name: 'A', color: 'blue', isArchived: true },
    { id: 'b', name: 'B', color: 'blue' }
  ] as Parameters<typeof pickActiveProjectId>[0]

  it('prefers the preferred id, then the default, then the first not archived', () => {
    expect(pickActiveProjectId(projects, 'a', 'b')).toBe('a')
    expect(pickActiveProjectId(projects, 'missing', 'a')).toBe('a')
    expect(pickActiveProjectId(projects, null, null)).toBe('b')
    expect(pickActiveProjectId([projects[0]], null, null)).toBe('a')
    expect(pickActiveProjectId([], 'a', 'b')).toBe('')
  })
})

describe('buildProjectsFromRegistry', () => {
  it('maps a pathless summary to a project without a path', () => {
    const [project] = buildProjectsFromRegistry(list([summary('a', { path: null })]), [], [])

    expect(project.path).toBeUndefined()
  })
})
