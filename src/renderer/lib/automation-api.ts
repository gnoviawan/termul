/**
 * Automations facade: the host-owned automations, runs and secrets, reached
 * identically from the desktop (Tauri commands) and from a remote client (HTTP
 * routes). Components import from here, never `invoke` or `fetch`.
 *
 * Every reply is parsed at this boundary (`automation-wire.ts`); a reply that
 * does not match the contract becomes a failed result with
 * `code: 'INVALID_RESPONSE'`. Secret values go out through
 * {@link setAutomationSecret} and are never read back, returned or logged.
 */

import type {
  ApplyOpsResult,
  Automation,
  AutomationId,
  AutomationOp,
  AutomationRun,
  AutomationStep,
  RunId,
  Schedule
} from '@shared/types/automation.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { listen } from '@tauri-apps/api/event'
import {
  type AutomationAgent,
  type AutomationChange,
  type AutomationDetail,
  parseAgentList,
  parseApplyOpsResult,
  parseAutomation,
  parseAutomationChange,
  parseAutomationDetail,
  parseAutomationList,
  parseRun,
  parseRunList,
  parseSchedulePreview,
  parseSecretNames,
  parseStepList,
  type SchedulePreview,
  WireShapeError
} from './automation-wire'
import { deleteJson, getJson, postJsonOnce, putJson } from './ipc/http'
import { invokeIpc } from './ipc/tauri'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

export type { AutomationAgent, AutomationChange, AutomationDetail, SchedulePreview }

const SOURCE = 'automation-api'
/** Tauri event and watch delta name. */
export const AUTOMATION_CHANGED_EVENT = 'automation_changed'

type Reply = Promise<IpcResult<unknown>>

/** One method per row of the contract's Operations table, unparsed. */
export interface AutomationTransport {
  list(projectId: string): Reply
  get(id: AutomationId): Reply
  create(projectId: string, name: string): Reply
  applyOps(id: AutomationId, baseRevision: number, ops: AutomationOp[]): Reply
  remove(id: AutomationId): Reply
  setEnabled(id: AutomationId, enabled: boolean): Reply
  approve(id: AutomationId, revision: number): Reply
  runNow(id: AutomationId): Reply
  cancelRun(runId: RunId): Reply
  listRuns(id: AutomationId, limit: number): Reply
  runSteps(runId: RunId): Reply
  markSeen(id: AutomationId): Reply
  previewSchedule(schedule: Schedule): Reply
  listAgents(): Reply
  listSecrets(projectId: string): Reply
  setSecret(projectId: string, name: string, value: string): Reply
  deleteSecret(projectId: string, name: string): Reply
}

export const desktopAutomationTransport: AutomationTransport = {
  list: (projectId) => invokeIpc('automation_list', { projectId }),
  get: (id) => invokeIpc('automation_get', { id }),
  create: (projectId, name) => invokeIpc('automation_create', { projectId, name }),
  applyOps: (id, baseRevision, ops) => invokeIpc('automation_apply_ops', { id, baseRevision, ops }),
  remove: (id) => invokeIpc('automation_delete', { id }),
  setEnabled: (id, enabled) => invokeIpc('automation_set_enabled', { id, enabled }),
  approve: (id, revision) => invokeIpc('automation_approve', { id, revision }),
  runNow: (id) => invokeIpc('automation_run_now', { id }),
  cancelRun: (runId) => invokeIpc('automation_cancel_run', { runId }),
  listRuns: (id, limit) => invokeIpc('automation_list_runs', { id, limit }),
  runSteps: (runId) => invokeIpc('automation_run_steps', { runId }),
  markSeen: (id) => invokeIpc('automation_mark_seen', { id }),
  previewSchedule: (schedule) => invokeIpc('automation_preview_schedule', { schedule }),
  listAgents: () => invokeIpc('automation_list_agents'),
  listSecrets: (projectId) => invokeIpc('automation_list_secrets', { projectId }),
  setSecret: (projectId, name, value) =>
    invokeIpc('automation_set_secret', { projectId, name, value }),
  deleteSecret: (projectId, name) => invokeIpc('automation_delete_secret', { projectId, name })
}

const AUTOMATIONS = '/api/automations'
const RUNS = '/api/automation-runs'
const SECRETS = '/api/automation-secrets'
const seg = encodeURIComponent

export const webAutomationTransport: AutomationTransport = {
  list: (projectId) => getJson(`${AUTOMATIONS}?project_id=${seg(projectId)}`),
  get: (id) => getJson(`${AUTOMATIONS}/${seg(id)}`),
  create: (projectId, name) => postJsonOnce(AUTOMATIONS, { project_id: projectId, name }),
  applyOps: (id, baseRevision, ops) =>
    postJsonOnce(`${AUTOMATIONS}/${seg(id)}/ops`, { base_revision: baseRevision, ops }),
  remove: (id) => deleteJson(`${AUTOMATIONS}/${seg(id)}`),
  setEnabled: (id, enabled) => postJsonOnce(`${AUTOMATIONS}/${seg(id)}/enabled`, { enabled }),
  approve: (id, revision) => postJsonOnce(`${AUTOMATIONS}/${seg(id)}/approve`, { revision }),
  runNow: (id) => postJsonOnce(`${AUTOMATIONS}/${seg(id)}/run`, {}),
  cancelRun: (runId) => postJsonOnce(`${RUNS}/${seg(runId)}/cancel`, {}),
  listRuns: (id, limit) => getJson(`${AUTOMATIONS}/${seg(id)}/runs?limit=${limit}`),
  runSteps: (runId) => getJson(`${RUNS}/${seg(runId)}/steps`),
  markSeen: (id) => postJsonOnce(`${AUTOMATIONS}/${seg(id)}/seen`, {}),
  previewSchedule: (schedule) => postJsonOnce(`${AUTOMATIONS}/preview-schedule`, { schedule }),
  listAgents: () => getJson('/api/automation-agents'),
  listSecrets: (projectId) => getJson(`${SECRETS}?project_id=${seg(projectId)}`),
  setSecret: (projectId, name, value) => putJson(SECRETS, { project_id: projectId, name, value }),
  deleteSecret: (projectId, name) =>
    deleteJson(`${SECRETS}?project_id=${seg(projectId)}&name=${seg(name)}`)
}

function transport(): AutomationTransport {
  return isTauriContext() ? desktopAutomationTransport : webAutomationTransport
}

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: SOURCE, message })
}

async function parsed<T>(
  operation: string,
  reply: Reply,
  parse: (data: unknown) => T
): Promise<IpcResult<T>> {
  const result = await reply
  if (!result.success) {
    log('warn', `${operation} failed: code=${result.code}`)
    return result
  }
  try {
    return { success: true, data: parse(result.data) }
  } catch (err) {
    if (!(err instanceof WireShapeError)) throw err
    log('warn', `${operation} returned an unexpected shape: ${err.message}`)
    return { success: false, error: err.message, code: 'INVALID_RESPONSE' }
  }
}

async function unit(operation: string, reply: Reply): Promise<IpcResult<void>> {
  const result = await reply
  if (!result.success) {
    log('warn', `${operation} failed: code=${result.code}`)
    return result
  }
  return { success: true, data: undefined }
}

export function listAutomations(projectId: string): Promise<IpcResult<Automation[]>> {
  return parsed('list', transport().list(projectId), parseAutomationList)
}

export function getAutomation(id: AutomationId): Promise<IpcResult<AutomationDetail>> {
  return parsed('get', transport().get(id), parseAutomationDetail)
}

export function createAutomation(projectId: string, name: string): Promise<IpcResult<Automation>> {
  return parsed('create', transport().create(projectId, name), (data) => parseAutomation(data))
}

export function applyAutomationOps(
  id: AutomationId,
  baseRevision: number,
  ops: AutomationOp[]
): Promise<IpcResult<ApplyOpsResult>> {
  return parsed('apply_ops', transport().applyOps(id, baseRevision, ops), parseApplyOpsResult)
}

export async function deleteAutomation(id: AutomationId): Promise<IpcResult<void>> {
  const result = await unit('delete', transport().remove(id))
  if (result.success) log('info', `deleted automation=${id}`)
  return result
}

export function setAutomationEnabled(id: AutomationId, enabled: boolean): Promise<IpcResult<void>> {
  return unit('set_enabled', transport().setEnabled(id, enabled))
}

export async function approveAutomation(
  id: AutomationId,
  revision: number
): Promise<IpcResult<void>> {
  const result = await unit('approve', transport().approve(id, revision))
  if (result.success) log('info', `approved automation=${id} revision=${revision}`)
  return result
}

export async function runAutomationNow(id: AutomationId): Promise<IpcResult<AutomationRun>> {
  const result = await parsed('run_now', transport().runNow(id), (data) => parseRun(data))
  if (result.success) log('info', `run now automation=${id} run=${result.data.id}`)
  return result
}

export function cancelAutomationRun(runId: RunId): Promise<IpcResult<void>> {
  return unit('cancel_run', transport().cancelRun(runId))
}

export function listAutomationRuns(
  id: AutomationId,
  limit: number
): Promise<IpcResult<AutomationRun[]>> {
  return parsed('list_runs', transport().listRuns(id, limit), parseRunList)
}

export function getAutomationRunSteps(runId: RunId): Promise<IpcResult<AutomationStep[]>> {
  return parsed('run_steps', transport().runSteps(runId), parseStepList)
}

export function markAutomationSeen(id: AutomationId): Promise<IpcResult<void>> {
  return unit('mark_seen', transport().markSeen(id))
}

export function previewSchedule(schedule: Schedule): Promise<IpcResult<SchedulePreview>> {
  return parsed('preview_schedule', transport().previewSchedule(schedule), parseSchedulePreview)
}

export function listAutomationAgents(): Promise<IpcResult<AutomationAgent[]>> {
  return parsed('list_agents', transport().listAgents(), parseAgentList)
}

export function listAutomationSecrets(projectId: string): Promise<IpcResult<string[]>> {
  return parsed('list_secrets', transport().listSecrets(projectId), parseSecretNames)
}

export async function setAutomationSecret(
  projectId: string,
  name: string,
  value: string
): Promise<IpcResult<void>> {
  const result = await unit('set_secret', transport().setSecret(projectId, name, value))
  if (result.success) log('info', `set secret name=${name} project=${projectId}`)
  return result
}

export async function deleteAutomationSecret(
  projectId: string,
  name: string
): Promise<IpcResult<void>> {
  const result = await unit('delete_secret', transport().deleteSecret(projectId, name))
  if (result.success) log('info', `deleted secret name=${name} project=${projectId}`)
  return result
}

/**
 * `null` means "a change may have been missed" (the host's watch resynced):
 * re-read everything shown.
 */
export type AutomationChangeListener = (change: AutomationChange | null) => void

const changeListeners = new Set<AutomationChangeListener>()
let desktopListening = false

function listenOnDesktop(): void {
  if (desktopListening || !isTauriContext()) return
  desktopListening = true
  listen<unknown>(AUTOMATION_CHANGED_EVENT, (event) =>
    publishAutomationChange(event.payload)
  ).catch((err: unknown) => {
    desktopListening = false
    log('warn', `listen(${AUTOMATION_CHANGED_EVENT}) failed: ${String(err)}`)
  })
}

/** Subscribe to `automation_changed` on either transport; returns the unsubscribe. */
export function onAutomationChanged(listener: AutomationChangeListener): () => void {
  listenOnDesktop()
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/**
 * Hand an `automation_changed` payload to subscribers. The desktop listener
 * and the web roster watch both call this. A payload that does not match the
 * contract is logged and dropped.
 */
export function publishAutomationChange(payload: unknown): void {
  const change = parseAutomationChange(payload)
  if (!change) {
    log('warn', `ignored an ${AUTOMATION_CHANGED_EVENT} event with an unexpected shape`)
    return
  }
  for (const listener of changeListeners) listener(change)
}

export function requestAutomationResync(): void {
  for (const listener of changeListeners) listener(null)
}
