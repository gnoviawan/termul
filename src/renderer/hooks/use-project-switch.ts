import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * How a `switchTo` call ended. `completed`, `selected` and `queued` mirror the
 * transport's reply; `failed` means the switch was refused (the failure is
 * already toasted, logged and marked on the store); `ignored` means nothing was
 * sent because the target cannot be switched to right now.
 */
export type ProjectSwitchStatus = 'completed' | 'selected' | 'queued' | 'failed' | 'ignored'

export interface ProjectSwitch {
  /** Switches the shared session to `projectId`; see {@link ProjectSwitchStatus}. */
  switchTo: (projectId: string) => Promise<ProjectSwitchStatus>
  /** Dismisses the transient "Failed" marker of the last refused switch. */
  clearFailed: () => void
}

/**
 * The one project-switch routine behind the project sheet and the mobile
 * command palette, so both get the same spinner, Queued and Failed markers,
 * shell announcements, failure toast and log.
 *
 * Stateless on purpose: the store's `switchingProjectId` is published before
 * `switchProject` yields, so it is the single in-flight marker for every
 * caller. The hook therefore holds no subscriptions and its result is stable
 * for a given `source`; components that render switch state read it through
 * {@link useProjectSwitchState}.
 *
 * `source` names the caller in the failure log.
 */
export function useProjectSwitch(source: string): ProjectSwitch {
  const switchTo = useCallback(
    async (projectId: string): Promise<ProjectSwitchStatus> => {
      const acp = useAcpStore.getState()
      const { projects, activeProjectId } = useProjectStore.getState()
      const project = projects.find((candidate) => candidate.id === projectId)
      // A switch is in flight or queued, or the target is unknown, archived or
      // already active (re-selecting it would start a fresh session at the same
      // cwd). The project sheet shows these rows disabled; the palette has no
      // such affordance, so the guard lives here for both.
      if (
        !project ||
        project.isArchived ||
        projectId === activeProjectId ||
        acp.switchingProjectId !== null ||
        acp.queuedProjectSwitchId !== null
      ) {
        return 'ignored'
      }
      try {
        const outcome = await acp.switchProject(projectId)
        return outcome.status
      } catch (err) {
        // `AcpTransportError.message` is the human string callers already toast
        // (e.g. "no_agent" → "switch_project requires a live agent; …"). The
        // failed id surfaces it inline in the project sheet too, because toasts
        // are easy to miss on mobile.
        const message = err instanceof Error ? err.message : String(err)
        acp.setFailedProjectSwitch(projectId)
        toast.error(message)
        void logFrontendError({
          level: 'warn',
          source,
          message: `Project switch failed for ${projectId}: ${message}`
        })
        return 'failed'
      }
    },
    [source]
  )

  const clearFailed = useCallback((): void => {
    useAcpStore.getState().setFailedProjectSwitch(null)
  }, [])

  return useMemo(() => ({ switchTo, clearFailed }), [switchTo, clearFailed])
}

export interface ProjectSwitchState {
  /** Target of the switch awaiting the transport. */
  switchingId: string | null
  /** Target of the switch the server queued behind a running turn. */
  queuedId: string | null
  /** Target of the last refused switch; transient. */
  failedId: string | null
  /** A switch is in flight or queued, so new switches are ignored. */
  busy: boolean
}

/** Reactive view of the project-switch markers, for surfaces that render them. */
export function useProjectSwitchState(): ProjectSwitchState {
  const switchingId = useAcpStore((state) => state.switchingProjectId)
  const queuedId = useAcpStore((state) => state.queuedProjectSwitchId)
  const failedId = useAcpStore((state) => state.failedProjectSwitchId)
  return { switchingId, queuedId, failedId, busy: switchingId !== null || queuedId !== null }
}
