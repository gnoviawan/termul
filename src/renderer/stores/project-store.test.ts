import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { registry, toastError, writeActiveProject } = vi.hoisted(() => ({
  registry: {
    add: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn()
  },
  toastError: vi.fn(),
  writeActiveProject: vi.fn()
}))

vi.mock('@/lib/project-registry-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-registry-api')>()),
  projectRegistryApi: registry
}))
vi.mock('@/lib/active-project', () => ({ writeActiveProject }))
vi.mock('@/lib/api', () => ({
  persistenceApi: { read: vi.fn(), write: vi.fn(), writeDebounced: vi.fn() },
  secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { _resetProjectPrefsForTests, getProjectPrefs } from '@/lib/project-prefs'
import { ProjectBusyError } from '@/lib/project-registry-api'
import { useProjectBusyStore } from './project-busy-store'
import { useProjectStore } from './project-store'

describe('project-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const command of Object.values(registry)) command.mockResolvedValue(undefined)
    _resetProjectPrefsForTests()
    useProjectBusyStore.setState({ requests: [], isResending: false })
    // Reset store to initial state before each test
    useProjectStore.setState({
      projects: [
        {
          id: '1',
          name: 'Web App',
          color: 'blue',
          path: '~/projects/web-app',
          gitBranch: 'main',
          isActive: true
        },
        {
          id: '2',
          name: 'API Service',
          color: 'purple',
          path: '~/projects/api-service',
          gitBranch: 'develop'
        }
      ],
      groups: [],
      activeProjectId: '1',
      isLoaded: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('initial state', () => {
    it('should have empty projects array by default', () => {
      // Reset to true initial state (no beforeEach data)
      useProjectStore.setState({ projects: [], activeProjectId: '' })
      const { projects } = useProjectStore.getState()
      expect(projects).toEqual([])
    })

    it('should have empty activeProjectId by default', () => {
      // Reset to true initial state (no beforeEach data)
      useProjectStore.setState({ projects: [], activeProjectId: '' })
      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe('')
    })
  })

  describe('selectProject', () => {
    it('should update activeProjectId', () => {
      const { selectProject } = useProjectStore.getState()
      selectProject('2')

      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe('2')
    })

    it('should update isActive property on projects', () => {
      const { selectProject } = useProjectStore.getState()
      selectProject('2')

      const { projects } = useProjectStore.getState()
      const project1 = projects.find((p) => p.id === '1')
      const project2 = projects.find((p) => p.id === '2')

      expect(project1?.isActive).toBe(false)
      expect(project2?.isActive).toBe(true)
    })

    it('writes only the device active-project key, never the registry', () => {
      useProjectStore.getState().selectProject('2')

      expect(writeActiveProject).toHaveBeenCalledTimes(1)
      expect(writeActiveProject).toHaveBeenCalledWith('2')
      for (const command of Object.values(registry)) expect(command).not.toHaveBeenCalled()
    })

    it('does not rewrite the key when the project is already active', () => {
      useProjectStore.getState().selectProject('1')

      expect(writeActiveProject).not.toHaveBeenCalled()
    })
  })

  describe('addProject', () => {
    /** The `projects` watch listing the project, as the host's state frame does. */
    function listViaWatch(id: string): void {
      const { projects, setProjects, activeProjectId, groups } = useProjectStore.getState()
      setProjects(
        [...projects, { id, name: 'Listed', color: 'red', path: '/test/path' }],
        activeProjectId,
        groups
      )
    }

    it('registers with a client-minted id and leaves the list to the watch', async () => {
      const pending = useProjectStore.getState().addProject('New Project', 'red', '/test/path')
      await vi.waitFor(() => expect(registry.add).toHaveBeenCalledTimes(1))

      const sent = registry.add.mock.calls[0][0] as { id: string }
      expect(sent).toEqual({
        id: expect.any(String),
        name: 'New Project',
        path: '/test/path',
        color: 'red'
      })
      // Not in the store until the watch lists it.
      expect(useProjectStore.getState().projects).toHaveLength(2)

      listViaWatch(sent.id)
      await pending
      expect(useProjectStore.getState().projects).toHaveLength(3)
    })

    it('resolves with the listed project and selects it (writing only the device key)', async () => {
      const pending = useProjectStore.getState().addProject('Auto-Selected Project', 'yellow', '/p')
      await vi.waitFor(() => expect(registry.add).toHaveBeenCalled())
      const { id } = registry.add.mock.calls[0][0] as { id: string }
      listViaWatch(id)

      const created = await pending

      expect(created.id).toBe(id)
      expect(useProjectStore.getState().activeProjectId).toBe(id)
      expect(writeActiveProject).toHaveBeenCalledWith(id)
    })

    it('keeps the shell and env vars for the watch state that lists the project', async () => {
      const envVars = [{ key: 'PORT', value: '3000' }]
      const pending = useProjectStore
        .getState()
        .addProject('Shelly', 'blue', '/p', '/bin/zsh', envVars)
      await vi.waitFor(() => expect(registry.add).toHaveBeenCalled())
      const { id } = registry.add.mock.calls[0][0] as { id: string }

      expect(getProjectPrefs(id)).toMatchObject({ defaultShell: '/bin/zsh', envVars })

      listViaWatch(id)
      await pending
    })

    it('should omit gitBranch on creation (auto-detected on activation)', async () => {
      const pending = useProjectStore.getState().addProject('Test', 'blue', '/p')
      await vi.waitFor(() => expect(registry.add).toHaveBeenCalled())
      listViaWatch((registry.add.mock.calls[0][0] as { id: string }).id)
      const newProject = await pending

      // No stale hardcoded 'main' default — the status bar used to show 'main'
      // before the real branch was detected. `useProjectGitBranch` now seeds
      // the actual HEAD branch on project activation.
      expect(newProject.gitBranch).toBeUndefined()
    })

    it('rejects and changes nothing when the host refuses the registration', async () => {
      registry.add.mockRejectedValueOnce(new Error('duplicate'))

      await expect(useProjectStore.getState().addProject('Dup', 'blue', '/p')).rejects.toThrow(
        'duplicate'
      )

      expect(useProjectStore.getState().projects).toHaveLength(2)
      expect(useProjectStore.getState().activeProjectId).toBe('1')
      expect(writeActiveProject).not.toHaveBeenCalled()
    })

    it('selects the project after the wait even when the watch is late', async () => {
      vi.useFakeTimers()
      const pending = useProjectStore.getState().addProject('Late', 'blue', '/p')
      await vi.advanceTimersByTimeAsync(5001)
      const created = await pending

      expect(useProjectStore.getState().activeProjectId).toBe(created.id)
    })
  })

  describe('updateProject', () => {
    it('applies client-only prefs locally without asking the host', () => {
      const { updateProject } = useProjectStore.getState()
      updateProject('1', { gitBranch: 'feature', defaultShell: '/bin/zsh' })

      const project = useProjectStore.getState().projects.find((p) => p.id === '1')
      expect(project).toMatchObject({ gitBranch: 'feature', defaultShell: '/bin/zsh' })
      expect(registry.update).not.toHaveBeenCalled()
    })

    it('sends a rename to the host and leaves the name for the watch to deliver', () => {
      useProjectStore.getState().updateProject('1', { name: 'Updated Name' })

      expect(registry.update).toHaveBeenCalledWith('1', { name: 'Updated Name' }, undefined)
      const project = useProjectStore.getState().projects.find((p) => p.id === '1')
      expect(project?.name).toBe('Web App')
    })

    it('splits one update into the host part and the local part', () => {
      useProjectStore
        .getState()
        .updateProject('1', { color: 'green', envVars: [{ key: 'A', value: '1' }] })

      expect(registry.update).toHaveBeenCalledWith('1', { color: 'green' }, undefined)
      const project = useProjectStore.getState().projects.find((p) => p.id === '1')
      expect(project?.envVars).toEqual([{ key: 'A', value: '1' }])
      expect(project?.color).toBe('blue')
    })

    it('sends nothing when the name and colour are unchanged', () => {
      useProjectStore.getState().updateProject('1', { name: 'Web App', color: 'blue' })

      expect(registry.update).not.toHaveBeenCalled()
    })

    it('sends a root folder change to the host and not an unchanged or empty one', () => {
      useProjectStore.getState().updateProject('1', { path: '  ~/projects/web-app ' })
      useProjectStore.getState().updateProject('1', { path: '   ' })
      expect(registry.update).not.toHaveBeenCalled()

      useProjectStore.getState().updateProject('1', { path: '/elsewhere/web-app' })

      expect(registry.update).toHaveBeenCalledWith('1', { path: '/elsewhere/web-app' }, undefined)
      const project = useProjectStore.getState().projects.find((p) => p.id === '1')
      expect(project?.path).toBe('~/projects/web-app')
    })

    it('parks a busy folder change for the user and resends with cascade after confirmation', async () => {
      registry.update.mockRejectedValueOnce(new ProjectBusyError('1', ['s1'], ['t1', 't2']))
      useProjectStore.getState().updateProject('1', { name: 'Renamed', path: '/elsewhere' })

      await vi.waitFor(() => expect(useProjectBusyStore.getState().requests).toHaveLength(1))
      expect(useProjectBusyStore.getState().requests[0]).toMatchObject({
        kind: 'move',
        projectId: '1',
        projectName: 'Web App',
        sessions: 1,
        terminals: 2
      })
      expect(registry.update).toHaveBeenCalledTimes(1)

      await useProjectBusyStore.getState().confirm()

      expect(registry.update).toHaveBeenLastCalledWith(
        '1',
        { name: 'Renamed', path: '/elsewhere' },
        { cascade: true }
      )
    })

    it('tells the user when the host refuses the change', async () => {
      registry.update.mockRejectedValueOnce(new Error('not found'))
      useProjectStore.getState().updateProject('1', { name: 'Nope' })

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith('Could not update the project: not found')
      )
    })

    it('should only update specified properties', () => {
      const { updateProject } = useProjectStore.getState()
      updateProject('1', { gitBranch: 'dev' })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.color).toBe('blue')
      expect(project?.path).toBe('~/projects/web-app')
    })
  })

  describe('deleteProject', () => {
    it('asks the host and leaves the removal to the watch', async () => {
      await useProjectStore.getState().deleteProject('2')

      expect(registry.remove).toHaveBeenCalledWith('2', undefined)
      expect(useProjectStore.getState().projects.find((p) => p.id === '2')).toBeDefined()
    })

    it('drops the project from the groups once the host removed it', async () => {
      useProjectStore.setState({
        groups: [{ id: 'g', name: 'G', projectIds: ['1', '2'], isCollapsed: false }]
      })

      await useProjectStore.getState().deleteProject('2')

      expect(useProjectStore.getState().groups[0].projectIds).toEqual(['1'])
    })

    it('parks a busy refusal for the user and stops nothing', async () => {
      registry.remove.mockRejectedValueOnce(new ProjectBusyError('2', ['s1', 's2'], ['t1']))

      await useProjectStore.getState().deleteProject('2')

      const [request] = useProjectBusyStore.getState().requests
      expect(request).toMatchObject({
        kind: 'delete',
        projectId: '2',
        projectName: 'API Service',
        sessions: 2,
        terminals: 1
      })
      expect(registry.remove).toHaveBeenCalledTimes(1)
      expect(toastError).not.toHaveBeenCalled()
    })

    it('resends with cascade only when the busy request is confirmed', async () => {
      registry.remove.mockRejectedValueOnce(new ProjectBusyError('2', ['s1'], []))
      await useProjectStore.getState().deleteProject('2')
      expect(registry.remove).toHaveBeenCalledTimes(1)

      await useProjectBusyStore.getState().confirm()

      expect(registry.remove).toHaveBeenCalledTimes(2)
      expect(registry.remove).toHaveBeenLastCalledWith('2', { cascade: true })
      expect(useProjectBusyStore.getState().requests).toEqual([])
    })

    it('tells the user when the host refuses for another reason', async () => {
      registry.remove.mockRejectedValueOnce(new Error('disk full'))

      await useProjectStore.getState().deleteProject('2')

      expect(toastError).toHaveBeenCalledWith('Could not delete the project: disk full')
      expect(useProjectBusyStore.getState().requests).toEqual([])
    })
  })

  describe('archiveProject', () => {
    it('asks the host to archive and leaves the flag to the watch', async () => {
      await useProjectStore.getState().archiveProject('1')

      expect(registry.archive).toHaveBeenCalledWith('1', undefined)
      const project = useProjectStore.getState().projects.find((p) => p.id === '1')
      expect(project?.isArchived).toBeUndefined()
    })

    it('parks a busy refusal and resends with cascade after confirmation', async () => {
      registry.archive.mockRejectedValueOnce(new ProjectBusyError('1', [], ['t1', 't2']))

      await useProjectStore.getState().archiveProject('1')
      expect(useProjectBusyStore.getState().requests[0]).toMatchObject({
        kind: 'archive',
        projectName: 'Web App',
        terminals: 2
      })

      await useProjectBusyStore.getState().confirm()
      expect(registry.archive).toHaveBeenLastCalledWith('1', { cascade: true })
    })
  })

  describe('restoreProject', () => {
    it('asks the host to restore the project', async () => {
      await useProjectStore.getState().restoreProject('1')

      expect(registry.restore).toHaveBeenCalledWith('1')
    })

    it('tells the user when the host refuses', async () => {
      registry.restore.mockRejectedValueOnce(new Error('gone'))

      await useProjectStore.getState().restoreProject('1')

      expect(toastError).toHaveBeenCalledWith('Could not restore the project: gone')
    })
  })

  describe('setProjects', () => {
    it('should replace all projects', () => {
      const { setProjects } = useProjectStore.getState()
      const newProjects = [{ id: 'new', name: 'New', color: 'cyan' as const }]

      setProjects(newProjects)

      const { projects } = useProjectStore.getState()
      expect(projects.length).toBe(1)
      expect(projects[0].id).toBe('new')
    })

    it('should preserve activeProjectId when setting new projects', () => {
      const { setProjects } = useProjectStore.getState()
      const newProjects = [
        { id: '1', name: 'Same ID', color: 'cyan' as const },
        { id: '3', name: 'Other', color: 'red' as const }
      ]

      setProjects(newProjects)

      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe('1')
    })
  })

  describe('reorderProjects', () => {
    it('should reorder active projects based on provided order', () => {
      const { reorderProjects } = useProjectStore.getState()

      // Reverse the order: ['2', '1'] instead of ['1', '2']
      reorderProjects(['2', '1'])

      const { projects } = useProjectStore.getState()
      expect(projects[0].id).toBe('2')
      expect(projects[1].id).toBe('1')
    })

    it('should preserve archived projects at the end', () => {
      // The host archived project 2 (delivered by the watch)
      useProjectStore.setState((state) => ({
        projects: state.projects.map((p) => (p.id === '2' ? { ...p, isArchived: true } : p))
      }))

      const { reorderProjects } = useProjectStore.getState()
      // Reorder only active projects (just '1' in this case)
      reorderProjects(['1'])

      const { projects } = useProjectStore.getState()
      // Active project should be first, archived should be last
      expect(projects[0].id).toBe('1')
      expect(projects[1].id).toBe('2')
      expect(projects[1].isArchived).toBe(true)
    })

    it('should handle reordering with multiple projects', () => {
      // The watch lists a third project
      const thirdId = 'third'
      useProjectStore.setState((state) => ({
        projects: [...state.projects, { id: thirdId, name: 'Third Project', color: 'green' }]
      }))

      const { reorderProjects } = useProjectStore.getState()
      // Move third project to first position
      reorderProjects([thirdId, '1', '2'])

      const { projects } = useProjectStore.getState()
      expect(projects[0].id).toBe(thirdId)
      expect(projects[1].id).toBe('1')
      expect(projects[2].id).toBe('2')
    })

    it('should ignore invalid project ids', () => {
      const { reorderProjects } = useProjectStore.getState()

      // Include an invalid id
      reorderProjects(['2', 'invalid-id', '1'])

      const { projects } = useProjectStore.getState()
      // Should only have the valid projects in order
      expect(projects.length).toBe(2)
      expect(projects[0].id).toBe('2')
      expect(projects[1].id).toBe('1')
    })
  })

  describe('envVars', () => {
    it('should store envVars when updating project', () => {
      const { updateProject } = useProjectStore.getState()
      const envVars = [
        { key: 'NODE_ENV', value: 'development' },
        { key: 'API_KEY', value: 'test-key', isSecret: true }
      ]

      updateProject('1', { envVars })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.envVars).toEqual(envVars)
    })

    it('should preserve envVars when updating other properties', () => {
      const { updateProject } = useProjectStore.getState()
      const envVars = [{ key: 'PORT', value: '3000' }]

      // First set envVars
      updateProject('1', { envVars })

      // Then update a different property
      updateProject('1', { gitBranch: 'new-branch' })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.envVars).toEqual(envVars)
      expect(project?.gitBranch).toBe('new-branch')
    })
  })

  describe('removeGroup', () => {
    it('removes the group and keeps its projects when asked to', () => {
      useProjectStore.setState({
        groups: [{ id: 'group1', name: 'My Group', projectIds: ['1'], isCollapsed: false }]
      })

      useProjectStore.getState().removeGroup('group1', false)

      expect(useProjectStore.getState().groups).toEqual([])
      expect(registry.remove).not.toHaveBeenCalled()
    })

    it('asks the host to remove every project in the group when deleting with its projects', async () => {
      useProjectStore.setState({
        groups: [{ id: 'group1', name: 'My Group', projectIds: ['1', '2'], isCollapsed: false }]
      })

      useProjectStore.getState().removeGroup('group1', true)

      await vi.waitFor(() => expect(registry.remove).toHaveBeenCalledTimes(2))
      expect(registry.remove.mock.calls.map((call) => call[0])).toEqual(['1', '2'])
      // The projects stay in the store until the watch drops them.
      expect(useProjectStore.getState().projects).toHaveLength(2)
    })
  })
})
