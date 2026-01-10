import { useEffect, useCallback, useRef } from 'react'
import { useProjectStore } from '@/stores/project-store'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type { PersistedProjectData, PersistedProject } from '../../shared/types/persistence.types'
import type { Project, ProjectColor } from '@/types/project'

function toPersistedProject(project: Project): PersistedProject {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    path: project.path,
    isArchived: project.isArchived,
    gitBranch: project.gitBranch,
    defaultShell: project.defaultShell
  }
}

function fromPersistedProject(persisted: PersistedProject): Project {
  return {
    id: persisted.id,
    name: persisted.name,
    color: persisted.color as ProjectColor,
    path: persisted.path,
    isArchived: persisted.isArchived,
    gitBranch: persisted.gitBranch,
    defaultShell: persisted.defaultShell
  }
}

export function useProjectsLoader(): void {
  const setProjects = useProjectStore((state) => state.setProjects)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await window.api.persistence.read<PersistedProjectData>(
        PersistenceKeys.projects
      )
      if (result.success && result.data) {
        const projects = result.data.projects.map(fromPersistedProject)
        // Validate activeProjectId exists in projects
        const validActiveId = projects.some((p) => p.id === result.data.activeProjectId)
          ? result.data.activeProjectId
          : projects.length > 0
            ? projects[0].id
            : ''
        setProjects(projects, validActiveId)
      } else {
        // No saved projects - start with empty state
        setProjects([])
      }
    }
    load()
  }, [setProjects])
}

/**
 * Hook to auto-save projects when the store changes
 * Subscribes to project store changes and triggers debounced writes
 */
export function useProjectsAutoSave(): void {
  const hasInitialized = useRef(false)

  useEffect(() => {
    // Subscribe to project store changes
    const unsubscribe = useProjectStore.subscribe((state, prevState) => {
      // Skip the first state change (from loading)
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      // Only save if projects or activeProjectId changed
      if (
        state.projects === prevState.projects &&
        state.activeProjectId === prevState.activeProjectId
      ) {
        return
      }

      const data: PersistedProjectData = {
        projects: state.projects.map(toPersistedProject),
        activeProjectId: state.activeProjectId,
        updatedAt: new Date().toISOString()
      }

      // Use debounced write via IPC
      window.api.persistence
        .writeDebounced(PersistenceKeys.projects, data)
        .catch((err: unknown) => {
          console.error('Failed to auto-save projects:', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

export function usePersistProjects(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await window.api.persistence.writeDebounced(PersistenceKeys.projects, data)
  }, [])
}

export function usePersistProjectsImmediate(): () => Promise<void> {
  return useCallback(async () => {
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await window.api.persistence.write(PersistenceKeys.projects, data)
  }, [])
}

export function useDeleteProjectWithCascade(): (id: string) => Promise<void> {
  return useCallback(async (id: string) => {
    // First delete the project from the store
    useProjectStore.getState().deleteProject(id)

    // Cascade delete: remove terminal layout and snapshots for this project
    await Promise.all([
      window.api.persistence.delete(PersistenceKeys.terminals(id)),
      window.api.persistence.delete(PersistenceKeys.snapshots(id))
    ])

    // Persist the updated projects list
    const { projects, activeProjectId } = useProjectStore.getState()
    const data: PersistedProjectData = {
      projects: projects.map(toPersistedProject),
      activeProjectId,
      updatedAt: new Date().toISOString()
    }
    await window.api.persistence.write(PersistenceKeys.projects, data)
  }, [])
}
