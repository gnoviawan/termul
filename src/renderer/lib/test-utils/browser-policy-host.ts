/**
 * An in-memory browser policy host for renderer tests. It applies the same
 * revision, scope and refusal rules as the Rust service, so a facade or a
 * settings component can be tested against realistic replies on either
 * transport (`invoke` for desktop, `fetch` for web).
 */

import type {
  AppBrowserPolicy,
  AppBrowserPolicyOp,
  BrowserPreapproval,
  ProjectBrowserPolicy,
  ProjectBrowserPolicyOp
} from '@shared/types/browser-policy.types'
import type { IpcResult } from '@shared/types/ipc.types'

export type HostCommand = 'get_project' | 'get_app' | 'apply_project' | 'apply_app'

export const DESKTOP_COMMANDS: Record<string, HostCommand> = {
  browser_policy_get_project: 'get_project',
  browser_policy_get_app: 'get_app',
  browser_policy_apply_project: 'apply_project',
  browser_policy_apply_app: 'apply_app'
}

export interface BrowserPolicyHost {
  projects: Map<string, ProjectBrowserPolicy>
  app: AppBrowserPolicy
  /** Runs once, right before the next project apply is evaluated. */
  beforeNextApply?: () => void
  applyCalls: number
  /** What the clear operation does; defaults to refusing like an unwired engine. */
  clearOutcome: 'unavailable' | 'ok'
  cleared: number
  /** Whether the engine can keep the shared agent profile (macOS 14+). */
  engineKeepsGlobal: boolean
  dispatch: (command: HostCommand, args: Record<string, unknown>) => IpcResult<unknown>
}

function refuse<T>(reason: string, message: string, code = 'invalid_params'): IpcResult<T> {
  return { success: false, error: `${reason}: ${message}`, code }
}

const RESERVED = /tauri\.localhost|ipc\.localhost|asset\.localhost|0\.0\.0\.0|169\.254\./
const APP_REFUSED_ACTIONS = new Set(['payment_submit'])

function checkOrigin(origin: string | undefined): IpcResult<never> | null {
  if (!origin || !/^https?:\/\/[^\s*]|^https?:\/\/\*\.[^\s*]/.test(origin)) {
    return refuse('invalid_origin', 'origin is not a valid http(s) origin')
  }
  if (RESERVED.test(origin)) {
    return refuse('reserved_origin', "termul's own app origins cannot be allow-listed")
  }
  return null
}

function sameEntry(a: BrowserPreapproval, b: BrowserPreapproval): boolean {
  return a.action === b.action && a.origin === b.origin
}

export function createBrowserPolicyHost(): BrowserPolicyHost {
  const host: BrowserPolicyHost = {
    projects: new Map(),
    app: {
      revision: 0,
      readOnly: false,
      globalProfileEnabled: true,
      effectiveGlobalProfile: true,
      askBeforePasswordSubmit: false,
      preapprovals: [],
      clearImpact: { sessions: 0, projects: 0 }
    },
    applyCalls: 0,
    clearOutcome: 'unavailable',
    cleared: 0,
    engineKeepsGlobal: true,
    dispatch: () => {
      throw new Error('replaced below')
    }
  }

  const projectOf = (id: string): ProjectBrowserPolicy => {
    let policy = host.projects.get(id)
    if (!policy) {
      policy = {
        projectId: id,
        revision: 0,
        readOnly: false,
        allowList: [],
        preapprovals: [],
        profileMode: 'global',
        effectiveProfileMode: 'global'
      }
      host.projects.set(id, policy)
    }
    return policy
  }

  const appView = (): AppBrowserPolicy => ({
    ...structuredClone(host.app),
    effectiveGlobalProfile: host.app.globalProfileEnabled && host.engineKeepsGlobal
  })

  const projectView = (policy: ProjectBrowserPolicy): ProjectBrowserPolicy => ({
    ...structuredClone(policy),
    effectiveProfileMode:
      policy.profileMode === 'global' && appView().effectiveGlobalProfile ? 'global' : 'ephemeral'
  })

  const applyProject = (args: Record<string, unknown>): IpcResult<unknown> => {
    host.applyCalls += 1
    host.beforeNextApply?.()
    host.beforeNextApply = undefined
    const policy = projectOf(String(args.projectId))
    if (policy.readOnly) return refuse('policy_read_only', 'this policy is read-only')
    if (args.expectedRevision !== policy.revision) {
      return refuse('revision_conflict', `the policy changed (now at revision ${policy.revision})`)
    }
    const op = args.op as ProjectBrowserPolicyOp
    let changed = false
    switch (op?.op) {
      case 'add_origin': {
        const bad = checkOrigin(op.origin)
        if (bad) return bad
        if (!policy.allowList.includes(op.origin)) {
          policy.allowList.push(op.origin)
          changed = true
        }
        break
      }
      case 'remove_origin': {
        const before = policy.allowList.length
        policy.allowList = policy.allowList.filter((o) => o !== op.origin)
        changed = policy.allowList.length !== before
        break
      }
      case 'add_preapproval': {
        const bad = checkOrigin(op.origin)
        if (bad) return bad
        if (!policy.preapprovals.some((p) => sameEntry(p, op))) {
          policy.preapprovals.push({ action: op.action, origin: op.origin })
          changed = true
        }
        break
      }
      case 'remove_preapproval': {
        const before = policy.preapprovals.length
        policy.preapprovals = policy.preapprovals.filter((p) => !sameEntry(p, op))
        changed = policy.preapprovals.length !== before
        break
      }
      case 'set_ephemeral': {
        const mode = op.ephemeral ? 'ephemeral' : 'global'
        changed = policy.profileMode !== mode
        policy.profileMode = mode
        break
      }
      default:
        return refuse('malformed_operation', 'the operation is not recognized')
    }
    if (changed) policy.revision += 1
    return { success: true, data: projectView(policy) }
  }

  const applyApp = (args: Record<string, unknown>): IpcResult<unknown> => {
    host.applyCalls += 1
    const op = args.op as AppBrowserPolicyOp
    if (op?.op === 'clear_global_profile') {
      if (host.clearOutcome === 'unavailable') {
        return refuse(
          'profile_engine_unavailable',
          'this build cannot clear the agent browser profile yet',
          'capability_unavailable'
        )
      }
      host.cleared += 1
      return { success: true, data: appView() }
    }
    if (host.app.readOnly) return refuse('policy_read_only', 'this policy is read-only')
    if (args.expectedRevision !== host.app.revision) {
      return refuse(
        'revision_conflict',
        `the policy changed (now at revision ${host.app.revision})`
      )
    }
    let changed = false
    switch (op?.op) {
      case 'set_global_profile':
        changed = host.app.globalProfileEnabled !== op.enabled
        host.app.globalProfileEnabled = op.enabled
        break
      case 'set_ask_before_password_submit':
        changed = host.app.askBeforePasswordSubmit !== op.enabled
        host.app.askBeforePasswordSubmit = op.enabled
        break
      case 'add_preapproval': {
        if (APP_REFUSED_ACTIONS.has(op.action)) {
          return refuse(
            'preapproval_not_allowed',
            'this action cannot be pre-approved in this scope'
          )
        }
        const bad = checkOrigin(op.origin)
        if (bad) return bad
        if (!host.app.preapprovals.some((p) => sameEntry(p, op))) {
          host.app.preapprovals.push({ action: op.action, origin: op.origin })
          changed = true
        }
        break
      }
      case 'remove_preapproval': {
        const before = host.app.preapprovals.length
        host.app.preapprovals = host.app.preapprovals.filter((p) => !sameEntry(p, op))
        changed = host.app.preapprovals.length !== before
        break
      }
      default:
        return refuse('malformed_operation', 'the operation is not recognized')
    }
    if (changed) host.app.revision += 1
    return { success: true, data: appView() }
  }

  host.dispatch = (command, args) => {
    switch (command) {
      case 'get_project':
        return { success: true, data: projectView(projectOf(String(args.projectId))) }
      case 'get_app':
        return { success: true, data: appView() }
      case 'apply_project':
        return applyProject(args)
      case 'apply_app':
        return applyApp(args)
    }
  }
  return host
}
