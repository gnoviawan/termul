import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAutomationFocus } from '@/components/automations/automation-focus'
import { onAutomationChanged } from '@/lib/automation-api'
import { logFrontendError } from '@/lib/log-api'
import { useWorkspaceStore } from '@/stores/workspace-store'

/**
 * When a chat agent proposes an automation in the project on screen, open
 * (or focus) that project's Automations tab on it so the user can review and
 * approve. A proposal for another project is left for its list.
 */
export function useAutomationProposals(): void {
  useEffect(
    () =>
      onAutomationChanged((change) => {
        if (!change?.proposed || change.automation_id === null) return
        const workspace = useWorkspaceStore.getState()
        if (workspace.activeProjectId !== change.project_id) {
          void logFrontendError({
            level: 'info',
            source: 'automations.proposals',
            message: `proposal ${change.automation_id} is for a project not on screen`
          })
          return
        }
        useAutomationFocus.getState().request(change.project_id, change.automation_id)
        workspace.addAutomationsTab(change.project_id)
        toast(`${change.proposed_by ?? 'An agent'} proposed an automation — review and approve`)
        void logFrontendError({
          level: 'info',
          source: 'automations.proposals',
          message: `opened proposal ${change.automation_id} for review`
        })
      }),
    []
  )
}
