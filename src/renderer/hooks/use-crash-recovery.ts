import { useEffect, useRef } from 'react'
import { sessionApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'

export function useCrashRecovery(): void {
  const didRestoreRef = useRef(false)

  useEffect(() => {
    if (didRestoreRef.current) return
    didRestoreRef.current = true

    void (async () => {
      const hasSessionResult = await sessionApi.hasSession()
      if (!hasSessionResult.success || !hasSessionResult.data) return

      const restoreResult = await sessionApi.restore()
      if (!restoreResult.success) return

      const currentState = useProjectStore.getState()
      if (currentState.activeProjectId) return

      const restorableWorkspace = restoreResult.data.workspaces.find((workspace) => {
        return currentState.projects.some((project) => project.id === workspace.projectId)
      })

      if (restorableWorkspace) {
        useProjectStore.setState({ activeProjectId: restorableWorkspace.projectId })
      }
    })()
  }, [])
}
