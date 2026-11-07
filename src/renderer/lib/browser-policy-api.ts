/**
 * Browser policy facade: the host-owned rules for agent browsing, read and
 * edited identically from the desktop (Tauri commands) and from a remote
 * client (HTTP routes). Components import from here, never `invoke` or
 * `fetch`.
 *
 * Edits are operations applied against a revision. A stale revision is
 * refused with `revision_conflict`; {@link editProjectBrowserPolicy} and
 * {@link editAppBrowserPolicy} reload and retry, so concurrent edits from two
 * surfaces never lose an update.
 */

import type {
  AppBrowserPolicy,
  AppBrowserPolicyOp,
  BrowserPolicyChange,
  BrowserPolicyReason,
  ProjectBrowserPolicy,
  ProjectBrowserPolicyOp
} from '@shared/types/browser-policy.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { getJson, postJsonOnce } from './ipc/http'
import { invokeIpc } from './ipc/tauri'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

const POLICY_BASE = '/host/browser-policy'
const SOURCE = 'browser-policy-api'
/** Reload-and-retry rounds after a stale revision before giving up. */
const MAX_CONFLICT_RETRIES = 4

export interface BrowserPolicyApi {
  getProject(projectId: string): Promise<IpcResult<ProjectBrowserPolicy>>
  getApp(): Promise<IpcResult<AppBrowserPolicy>>
  applyProject(
    projectId: string,
    expectedRevision: number,
    op: ProjectBrowserPolicyOp
  ): Promise<IpcResult<ProjectBrowserPolicy>>
  applyApp(expectedRevision: number, op: AppBrowserPolicyOp): Promise<IpcResult<AppBrowserPolicy>>
}

export const desktopBrowserPolicyApi: BrowserPolicyApi = {
  getProject: (projectId) => invokeIpc('browser_policy_get_project', { projectId }),
  getApp: () => invokeIpc('browser_policy_get_app'),
  applyProject: (projectId, expectedRevision, op) =>
    invokeIpc('browser_policy_apply_project', { projectId, expectedRevision, op }),
  applyApp: (expectedRevision, op) =>
    invokeIpc('browser_policy_apply_app', { expectedRevision, op })
}

export const webBrowserPolicyApi: BrowserPolicyApi = {
  getProject: (projectId) =>
    getJson(`${POLICY_BASE}/project?projectId=${encodeURIComponent(projectId)}`),
  getApp: () => getJson(`${POLICY_BASE}/app`),
  applyProject: (projectId, expectedRevision, op) =>
    postJsonOnce(`${POLICY_BASE}/project`, { projectId, expectedRevision, op }),
  applyApp: (expectedRevision, op) => postJsonOnce(`${POLICY_BASE}/app`, { expectedRevision, op })
}

function transport(): BrowserPolicyApi {
  return isTauriContext() ? desktopBrowserPolicyApi : webBrowserPolicyApi
}

type Failure = Extract<IpcResult<unknown>, { success: false }>

const KNOWN_REASONS: ReadonlySet<string> = new Set<BrowserPolicyReason>([
  'invalid_origin',
  'invalid_wildcard',
  'reserved_origin',
  'preapproval_not_allowed',
  'limit_exceeded',
  'malformed_operation',
  'invalid_project_id',
  'app_scope_required',
  'project_scope_mismatch',
  'revision_conflict',
  'policy_read_only',
  'policy_store_unavailable',
  'profile_engine_unavailable',
  'profile_clear_failed',
  'storage_failed'
])

export interface BrowserPolicyFailure {
  code: string
  /** `null` for failures that did not come from the policy service (network, auth). */
  reason: BrowserPolicyReason | null
  message: string
}

/** Split a failed reply's `error` (`<reason>: <message>`) into its parts. */
export function browserPolicyFailure(failure: Failure): BrowserPolicyFailure {
  const split = failure.error.indexOf(': ')
  const head = split > 0 ? failure.error.slice(0, split) : ''
  if (KNOWN_REASONS.has(head)) {
    return {
      code: failure.code,
      reason: head as BrowserPolicyReason,
      message: failure.error.slice(split + 2)
    }
  }
  return { code: failure.code, reason: null, message: failure.error }
}

function logFailure(operation: string, failure: Failure): void {
  const { code, reason } = browserPolicyFailure(failure)
  void logFrontendError({
    level: 'warn',
    source: SOURCE,
    message: `${operation} failed: code=${code} reason=${reason ?? 'none'}`
  })
}

export const browserPolicyApi: BrowserPolicyApi = {
  getProject: (projectId) => transport().getProject(projectId),
  getApp: () => transport().getApp(),
  applyProject: (projectId, expectedRevision, op) =>
    transport().applyProject(projectId, expectedRevision, op),
  applyApp: (expectedRevision, op) => transport().applyApp(expectedRevision, op)
}

function isConflict(result: IpcResult<unknown>): result is Failure {
  return !result.success && browserPolicyFailure(result).reason === 'revision_conflict'
}

/**
 * Apply one project operation, reloading and retrying while the revision is
 * stale. `known` is the policy the caller last saw (skips the first read).
 */
export async function editProjectBrowserPolicy(
  projectId: string,
  op: ProjectBrowserPolicyOp,
  known?: ProjectBrowserPolicy
): Promise<IpcResult<ProjectBrowserPolicy>> {
  const api = browserPolicyApi
  let revision = known?.revision
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    if (revision === undefined) {
      const fresh = await api.getProject(projectId)
      if (!fresh.success) {
        logFailure(`read project policy`, fresh)
        return fresh
      }
      revision = fresh.data.revision
    }
    const result = await api.applyProject(projectId, revision, op)
    if (!isConflict(result)) {
      if (!result.success) logFailure(`project policy ${op.op}`, result)
      return result
    }
    revision = undefined
  }
  return {
    success: false,
    error: 'revision_conflict: the policy kept changing; reload and retry',
    code: 'invalid_params'
  }
}

/** Apply one app-level operation with the same reload-and-retry rule. */
export async function editAppBrowserPolicy(
  op: AppBrowserPolicyOp,
  known?: AppBrowserPolicy
): Promise<IpcResult<AppBrowserPolicy>> {
  const api = browserPolicyApi
  let revision = known?.revision
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    if (revision === undefined) {
      const fresh = await api.getApp()
      if (!fresh.success) {
        logFailure('read app policy', fresh)
        return fresh
      }
      revision = fresh.data.revision
    }
    const result = await api.applyApp(revision, op)
    if (!isConflict(result)) {
      if (!result.success) logFailure(`app policy ${op.op}`, result)
      return result
    }
    revision = undefined
  }
  return {
    success: false,
    error: 'revision_conflict: the policy kept changing; reload and retry',
    code: 'invalid_params'
  }
}

type ChangeListener = (change: BrowserPolicyChange) => void

const changeListeners = new Set<ChangeListener>()

/** Subscribe to `browser_policy_changed`; returns the unsubscribe. */
export function onBrowserPolicyChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

const resyncListeners = new Set<() => void>()

/**
 * Subscribe to "a change may have been missed": the host's watch resynced, so
 * a `browser_policy_changed` hint can have been lost with it. Returns the
 * unsubscribe.
 */
export function onBrowserPolicyResync(listener: () => void): () => void {
  resyncListeners.add(listener)
  return () => {
    resyncListeners.delete(listener)
  }
}

export function requestBrowserPolicyResync(): void {
  for (const listener of resyncListeners) listener()
}

/**
 * Hand a `browser_policy_changed` payload to subscribers. Called by the
 * roster watch, which receives the host's event on both transports. A
 * payload that does not match the contract is logged and dropped.
 */
export function publishBrowserPolicyChange(payload: unknown): void {
  const change = parseChange(payload)
  if (!change) {
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: 'ignored a browser_policy_changed event with an unexpected shape'
    })
    return
  }
  for (const listener of changeListeners) listener(change)
}

function parseChange(payload: unknown): BrowserPolicyChange | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { scope, projectId, revision } = payload as Record<string, unknown>
  if (typeof revision !== 'number') return null
  if (scope === 'app') return { scope, revision }
  if (scope === 'project' && typeof projectId === 'string') return { scope, projectId, revision }
  return null
}
