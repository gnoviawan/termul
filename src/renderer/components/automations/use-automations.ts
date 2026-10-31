import type {
  Automation,
  AutomationChanged,
  AutomationDetail,
  AutomationId,
  AutomationRun,
  AutomationStep,
  AutomationSuggestion,
  RunId
} from '@shared/types/automation.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAutomation,
  getAutomationRunSteps,
  listAutomationRuns,
  listAutomationSuggestions,
  listAutomations,
  onAutomationChanged
} from '@/lib/automation-api'
import { useSuggestAutomations } from '@/stores/app-settings-store'

export interface HostQuery<T> {
  data: T | null
  error: string | null
  reload: () => void
}

/**
 * Load `load()` whenever `key` changes and again on every `automation_changed`
 * that `affects` accepts (and on a resync), and every `pollMs` when set. A
 * `null` key loads nothing. Only the latest request's reply is kept.
 */
function useHostQuery<T>(
  key: string | null,
  load: () => Promise<IpcResult<T>>,
  affects: (change: AutomationChanged) => boolean,
  pollMs: number | null = null
): HostQuery<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null
  })
  const latest = useRef({ load, affects, request: 0, pending: false })
  latest.current.load = load
  latest.current.affects = affects

  const reload = useCallback(() => {
    if (key === null) return
    const request = ++latest.current.request
    latest.current.pending = true
    void latest.current.load().then((result) => {
      if (request !== latest.current.request) return
      latest.current.pending = false
      setState((prev) =>
        result.success
          ? { key, data: result.data, error: null }
          : // Keep the last good data on screen when a refresh fails.
            { key, data: prev.key === key ? prev.data : null, error: result.error }
      )
    })
  }, [key])

  useEffect(() => {
    reload()
    if (key === null) return
    const unsubscribe = onAutomationChanged((change) => {
      if (change === null || latest.current.affects(change)) reload()
    })
    return () => {
      unsubscribe()
      // Drop any load still in flight so it never sets state after unmount.
      latest.current.request++
    }
  }, [key, reload])

  useEffect(() => {
    if (pollMs === null) return
    // A poll waits for the reply in flight: a newer request would discard it,
    // so a reply slower than `pollMs` would never land.
    const timer = setInterval(() => {
      if (!latest.current.pending) reload()
    }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, reload])

  const current = state.key === key
  return { data: current ? state.data : null, error: current ? state.error : null, reload }
}

export function useAutomationList(projectId: string): HostQuery<Automation[]> {
  return useHostQuery(
    projectId,
    () => listAutomations(projectId),
    (change) => change.project_id === projectId
  )
}

/** Open suggestions of the project; nothing is asked while the setting is off. */
export function useAutomationSuggestions(projectId: string): HostQuery<AutomationSuggestion[]> {
  const enabled = useSuggestAutomations()
  return useHostQuery(
    enabled ? projectId : null,
    () => listAutomationSuggestions(projectId),
    (change) => change.project_id === projectId
  )
}

export function useAutomationDetail(id: AutomationId | null): HostQuery<AutomationDetail> {
  return useHostQuery(
    id,
    () => getAutomation(id as AutomationId),
    (change) => change.automation_id === id
  )
}

export const RUNS_PAGE = 25

export function useAutomationRuns(id: AutomationId | null): HostQuery<AutomationRun[]> {
  return useHostQuery(
    id,
    () => listAutomationRuns(id as AutomationId, RUNS_PAGE),
    (change) => change.automation_id === id
  )
}

const RUNNING_POLL_MS = 2000

/** Steps of one run; polls while the run is still going. */
export function useRunSteps(run: AutomationRun | null): HostQuery<AutomationStep[]> {
  const runId: RunId | null = run?.id ?? null
  return useHostQuery(
    runId,
    () => getAutomationRunSteps(runId as RunId),
    (change) => change.automation_id === run?.automation_id,
    run?.status === 'running' ? RUNNING_POLL_MS : null
  )
}
