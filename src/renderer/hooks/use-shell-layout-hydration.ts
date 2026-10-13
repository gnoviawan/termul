import { useEffect } from 'react'
import { useProjectStore } from '@/stores/project-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'

/**
 * Boot wiring for the shell-layout store, mounted on both renderer roots
 * (`App.tsx`, `TauriApp.tsx`).
 *
 * - Hydrates the store once (single-flight inside the store): reads the saved
 *   record, or migrates the legacy values when none exists.
 * - Notices a Project disappearing from `useProjectStore` between two LOADED
 *   states (a remove from any device and a host cascade both arrive as a `projects` watch state) and
 *   asks the store to drop everything remembered for it. The initial load
 *   (`isLoaded` false -> true) is never treated as a removal.
 */
export function useShellLayoutHydration(): void {
  useEffect(() => {
    void useShellLayoutStore.getState().hydrate()

    return useProjectStore.subscribe((state, prevState) => {
      if (!state.isLoaded || !prevState.isLoaded) return
      if (state.projects === prevState.projects) return
      const present = new Set(state.projects.map((project) => project.id))
      for (const project of prevState.projects) {
        if (!present.has(project.id)) {
          void useShellLayoutStore.getState().removeProject(project.id)
        }
      }
    })
  }, [])
}
