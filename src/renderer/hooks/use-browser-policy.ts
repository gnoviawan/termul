import type {
  AppBrowserPolicy,
  AppBrowserPolicyOp,
  BrowserPolicyChange,
  ProjectBrowserPolicy,
  ProjectBrowserPolicyOp
} from '@shared/types/browser-policy.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type BrowserPolicyFailure,
  browserPolicyApi,
  browserPolicyFailure,
  editAppBrowserPolicy,
  editProjectBrowserPolicy,
  onBrowserPolicyChanged,
  onBrowserPolicyResync
} from '@/lib/browser-policy-api'

export type PolicyResource<P> =
  | { status: 'loading' }
  | { status: 'ready'; policy: P }
  | { status: 'error'; failure: BrowserPolicyFailure }

interface Resource<P, Op> {
  state: PolicyResource<P>
  /** Apply an operation; `null` on success, the failure otherwise. */
  edit: (op: Op) => Promise<BrowserPolicyFailure | null>
}

/**
 * One policy scope kept in step with the host: loaded on mount, re-read when
 * the host announces a change to it, and when the tab becomes visible again
 * (a phone that slept missed events).
 */
function usePolicyResource<P, Op>(
  scopeKey: string | null,
  load: () => Promise<IpcResult<P>>,
  apply: (op: Op, known: P | null) => Promise<IpcResult<P>>,
  isRelevant: (change: BrowserPolicyChange) => boolean
): Resource<P, Op> {
  const [state, setState] = useState<PolicyResource<P>>({ status: 'loading' })
  const generation = useRef(0)
  const latest = useRef({ load, apply, isRelevant })
  latest.current = { load, apply, isRelevant }
  const policyRef = useRef<P | null>(null)

  const reload = useCallback(async () => {
    const mine = ++generation.current
    const result = await latest.current.load()
    if (mine !== generation.current) return
    if (result.success) {
      policyRef.current = result.data
      setState({ status: 'ready', policy: result.data })
    } else {
      policyRef.current = null
      setState({ status: 'error', failure: browserPolicyFailure(result) })
    }
  }, [])

  useEffect(() => {
    if (scopeKey === null) return
    policyRef.current = null
    setState({ status: 'loading' })
    void reload()
    const stop = onBrowserPolicyChanged((change) => {
      if (latest.current.isRelevant(change)) void reload()
    })
    const stopResync = onBrowserPolicyResync(() => void reload())
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      generation.current += 1
      stop()
      stopResync()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [scopeKey, reload])

  const edit = useCallback(async (op: Op): Promise<BrowserPolicyFailure | null> => {
    const result = await latest.current.apply(op, policyRef.current)
    if (!result.success) return browserPolicyFailure(result)
    generation.current += 1
    policyRef.current = result.data
    setState({ status: 'ready', policy: result.data })
    return null
  }, [])

  return { state: scopeKey === null ? { status: 'loading' } : state, edit }
}

/** The browser policy of one project; `projectId` of `null` stays loading. */
export function useProjectBrowserPolicy(
  projectId: string | null
): Resource<ProjectBrowserPolicy, ProjectBrowserPolicyOp> {
  return usePolicyResource<ProjectBrowserPolicy, ProjectBrowserPolicyOp>(
    projectId,
    () => browserPolicyApi.getProject(projectId ?? ''),
    (op, known) => editProjectBrowserPolicy(projectId ?? '', op, known ?? undefined),
    (change) => change.scope === 'project' && change.projectId === projectId
  )
}

/** The app-wide browser policy. */
export function useAppBrowserPolicy(): Resource<AppBrowserPolicy, AppBrowserPolicyOp> {
  return usePolicyResource<AppBrowserPolicy, AppBrowserPolicyOp>(
    'app',
    () => browserPolicyApi.getApp(),
    (op, known) => editAppBrowserPolicy(op, known ?? undefined),
    (change) => change.scope === 'app'
  )
}
