/**
 * Project-switch coordinator (AD-13): the ONE latest-wins slot through which
 * every project switch runs.
 *
 *   request -> leave(committed) -> [hydrate off-store] -> commit (sync, atomic)
 *
 * Every request bumps `latest`, which supersedes whatever is in flight.
 * `isCurrent(token)` is re-checked after every await and immediately before
 * the commit, so a stale request can never write a store: a superseded
 * hydration is simply dropped, and a failed one is rolled back to the
 * committed project (a half-built tree is never committed).
 *
 * Dependencies are injected (`SwitchDeps`) so the race semantics are testable
 * without any store; `wiring.ts` binds the real ones.
 */

import { logFrontendError } from '@/lib/log-api'
import { useProjectStore } from '@/stores/project-store'
import {
  emptyStagedProject,
  type SwitchDeps,
  type SwitchOutcome,
  type SwitchRequest,
  type SwitchToken
} from './types'

const SOURCE = 'project-switch'

export interface ProjectSwitchCoordinator {
  request: (req: SwitchRequest) => Promise<SwitchOutcome>
  /** Cancel everything in flight; later requests resolve `cancelled`. */
  dispose: () => void
  isCurrent: (token: SwitchToken) => boolean
}

interface InFlight {
  id: number
  projectId: string
  kind: SwitchRequest['kind']
  promise: Promise<SwitchOutcome>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createProjectSwitchCoordinator(deps: SwitchDeps): ProjectSwitchCoordinator {
  let latest = 0
  let disposed = false
  let inFlight: InFlight | null = null
  const isCurrent = (token: SwitchToken): boolean =>
    !disposed &&
    token.id === latest &&
    deps.getActiveProjectId() === token.projectId &&
    (token.focusedPaneId === undefined || deps.getFocusedPaneId() === token.focusedPaneId)

  const runAfterCommit = (afterCommit: (() => void) | undefined, projectId: string): void => {
    try {
      afterCommit?.()
    } catch (error) {
      void logFrontendError({
        source: SOURCE,
        message: `afterCommit for project ${projectId} threw: ${describe(error)}`
      })
    }
  }

  const rollBack = (projectId: string, error: unknown): void => {
    const message = describe(error)
    void logFrontendError({
      source: SOURCE,
      message: `Switch to project ${projectId} failed: ${message}`
    })
    deps.setStatus({ kind: 'failed', projectId, message })
    try {
      const committed = deps.getCommittedProjectId()
      if (committed) {
        deps.revertTo(committed)
        return
      }
      // First boot: nothing to go back to. Degrade to a fresh tree for the
      // landing project rather than leaving the workspace without any.
      const landing = deps.landingProjectId()
      if (!landing) return
      deps.commit(landing, emptyStagedProject())
      deps.revertTo(landing)
    } catch (rollbackError) {
      void logFrontendError({
        source: SOURCE,
        message: `Rollback after failed switch to ${projectId} threw: ${describe(rollbackError)}`
      })
    }
  }

  const execute = async (
    req: SwitchRequest,
    token: SwitchToken,
    from: string
  ): Promise<SwitchOutcome> => {
    const abandoned = (): SwitchOutcome => (disposed ? 'cancelled' : 'superseded')
    try {
      if (from) await deps.leave(from)
      if (!isCurrent(token)) return abandoned()

      const isTokenCurrent = (): boolean => isCurrent(token)
      const staged = deps.hasTree(req.projectId)
        ? await deps.hydrateEditor(req.projectId, isTokenCurrent)
        : await deps.hydrate(req.projectId, isTokenCurrent)
      if (!isCurrent(token)) return abandoned()

      // No await between the check above and the commit: it is atomic.
      deps.commit(req.projectId, staged)
      runAfterCommit(req.afterCommit, req.projectId)
      deps.setStatus({ kind: 'idle' })
      return 'committed'
    } catch (error) {
      // A superseded request's failure is none of the user's business.
      if (disposed) return 'cancelled'
      if (token.id !== latest) return 'superseded'
      rollBack(req.projectId, error)
      return 'failed'
    }
  }

  const request = (req: SwitchRequest): Promise<SwitchOutcome> => {
    if (disposed) return Promise.resolve('cancelled')

    // An effect re-run (kind 'pick') must not cancel an explicit open's
    // afterCommit: join the open that is already in flight.
    if (
      req.kind === 'pick' &&
      inFlight &&
      inFlight.id === latest &&
      inFlight.kind === 'open' &&
      inFlight.projectId === req.projectId
    ) {
      return inFlight.promise
    }

    const id = ++latest
    inFlight = null

    const token: SwitchToken = {
      id,
      projectId: req.projectId,
      focusedPaneId: req.kind === 'open' ? deps.getFocusedPaneId() : undefined
    }

    const committed = deps.getCommittedProjectId()
    if (req.projectId === committed) {
      // Already showing it. The bump above still superseded any in-flight
      // request (the user came back before it landed).
      deps.setStatus({ kind: 'idle' })
      if (req.kind === 'open' && isCurrent(token)) runAfterCommit(req.afterCommit, req.projectId)
      return Promise.resolve('noop')
    }

    deps.setStatus({ kind: 'pending', projectId: req.projectId })

    const promise = execute(req, token, committed).finally(() => {
      if (inFlight?.id === id) inFlight = null
    })
    inFlight = { id, projectId: req.projectId, kind: req.kind, promise }
    return promise
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    inFlight = null
    deps.setStatus({ kind: 'idle' })
  }

  return { request, dispose, isCurrent }
}

let bound: ProjectSwitchCoordinator | null = null

/**
 * Process-wide handle to the bound coordinator, for callers outside React
 * (`open-agent-chat.ts`). The workspace hook binds real dependencies on mount
 * and unbinds (= disposes) on unmount.
 */
export const projectSwitch = {
  bind(deps: SwitchDeps): () => void {
    bound?.dispose()
    const coordinator = createProjectSwitchCoordinator(deps)
    bound = coordinator
    return () => {
      coordinator.dispose()
      if (bound === coordinator) bound = null
    }
  },

  request(req: SwitchRequest): Promise<SwitchOutcome> {
    if (!bound) {
      // No workspace mounted: nothing can commit. Fall back to a plain project
      // select so the intent is not lost; the mounting hook will pick it up.
      useProjectStore.getState().selectProject(req.projectId)
      return Promise.resolve('cancelled')
    }
    return bound.request(req)
  }
}
