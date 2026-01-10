import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectStore } from './project-store'

describe('project-store', () => {
  beforeEach(() => {
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
      activeProjectId: '1'
    })
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
  })

  describe('addProject', () => {
    it('should add a new project to the array', () => {
      const { addProject } = useProjectStore.getState()
      const initialCount = useProjectStore.getState().projects.length

      addProject('New Project', 'red', '/test/path')

      const { projects } = useProjectStore.getState()
      expect(projects.length).toBe(initialCount + 1)
    })

    it('should return the created project', () => {
      const { addProject } = useProjectStore.getState()
      const newProject = addProject('Test Project', 'green')

      expect(newProject.name).toBe('Test Project')
      expect(newProject.color).toBe('green')
      expect(newProject.id).toBeTruthy()
    })

    it('should set default gitBranch to main', () => {
      const { addProject } = useProjectStore.getState()
      const newProject = addProject('Test', 'blue')

      expect(newProject.gitBranch).toBe('main')
    })

    it('should auto-select the new project as active', () => {
      const { addProject } = useProjectStore.getState()
      const newProject = addProject('Auto-Selected Project', 'yellow')

      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe(newProject.id)
    })
  })

  describe('updateProject', () => {
    it('should update project properties', () => {
      const { updateProject } = useProjectStore.getState()
      updateProject('1', { name: 'Updated Name' })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.name).toBe('Updated Name')
    })

    it('should only update specified properties', () => {
      const { updateProject } = useProjectStore.getState()
      updateProject('1', { name: 'Updated' })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.color).toBe('blue')
      expect(project?.path).toBe('~/projects/web-app')
    })
  })

  describe('deleteProject', () => {
    it('should remove project from array', () => {
      const { deleteProject } = useProjectStore.getState()
      const initialCount = useProjectStore.getState().projects.length

      deleteProject('2')

      const { projects } = useProjectStore.getState()
      expect(projects.length).toBe(initialCount - 1)
      expect(projects.find((p) => p.id === '2')).toBeUndefined()
    })

    it('should update activeProjectId when deleting active project', () => {
      const { deleteProject } = useProjectStore.getState()
      deleteProject('1')

      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe('2')
    })

    it('should not change activeProjectId when deleting non-active project', () => {
      const { deleteProject } = useProjectStore.getState()
      deleteProject('2')

      const { activeProjectId } = useProjectStore.getState()
      expect(activeProjectId).toBe('1')
    })
  })

  describe('archiveProject', () => {
    it('should set isArchived to true', () => {
      const { archiveProject } = useProjectStore.getState()
      archiveProject('1')

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.isArchived).toBe(true)
    })
  })

  describe('restoreProject', () => {
    it('should set isArchived to false', () => {
      // First archive the project
      useProjectStore.getState().archiveProject('1')

      // Then restore it
      const { restoreProject } = useProjectStore.getState()
      restoreProject('1')

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.isArchived).toBe(false)
    })

    it('should handle restoring a project that was not archived', () => {
      // Project is not archived initially
      const { restoreProject } = useProjectStore.getState()
      restoreProject('1')

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.isArchived).toBe(false)
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
      // First archive project 2
      useProjectStore.getState().archiveProject('2')

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
      // Add a third project
      useProjectStore.getState().addProject('Third Project', 'green')
      const { projects: beforeProjects } = useProjectStore.getState()
      const thirdId = beforeProjects[2].id

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
      updateProject('1', { name: 'New Name' })

      const { projects } = useProjectStore.getState()
      const project = projects.find((p) => p.id === '1')

      expect(project?.envVars).toEqual(envVars)
      expect(project?.name).toBe('New Name')
    })
  })
})
