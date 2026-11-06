import type { AutomationId } from '@shared/types/automation.types'
import { create } from 'zustand'

interface AutomationFocusState {
  /** Per project, the automation its Automations tab should show next. */
  requests: Record<string, AutomationId>
  request: (projectId: string, id: AutomationId) => void
  /** Called by the tab once it shows the requested automation. */
  clear: (projectId: string) => void
}

/**
 * Asks a project's Automations tab to select one automation. Held until the
 * tab consumes it, so a request made before the tab mounts still lands.
 */
export const useAutomationFocus = create<AutomationFocusState>((set) => ({
  requests: {},
  request: (projectId, id) => set((s) => ({ requests: { ...s.requests, [projectId]: id } })),
  clear: (projectId) =>
    set((s) => {
      const { [projectId]: _done, ...rest } = s.requests
      return { requests: rest }
    })
}))
