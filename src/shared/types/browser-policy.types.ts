/**
 * Browser policy contract: the host-owned rules that govern agent browsing,
 * at two levels. Per project: an allow-list of origins, pre-approvals keyed
 * by (action, origin) and an opt-out to ephemeral browsing. App-wide: the
 * global agent profile switch, whether password submits prompt, app-scoped
 * pre-approvals and clearing the global agent profile.
 *
 * Desktop (Tauri commands) and remote clients (HTTP routes) exchange these
 * shapes unchanged. Edits are operations applied against a revision; a stale
 * revision is refused and the caller retries on fresh state.
 */

export type BrowserActionClass =
  | 'navigate'
  | 'local_network'
  | 'password_submit'
  | 'payment_submit'
  | 'upload'
  | 'download'
  | 'tainted_exfil'

/** Action classes a pre-approval may name for ephemeral tabs of one project. */
export const PROJECT_PREAPPROVABLE_ACTIONS = [
  'password_submit',
  'payment_submit',
  'upload',
  'download',
  'tainted_exfil'
] as const satisfies readonly BrowserActionClass[]

/**
 * Action classes an app-wide pre-approval may name. Payment submits are
 * absent on purpose: the global profile is shared by every project, so those
 * always prompt.
 */
export const APP_PREAPPROVABLE_ACTIONS = [
  'password_submit',
  'upload',
  'download',
  'tainted_exfil'
] as const satisfies readonly BrowserActionClass[]

export type BrowserProfileMode = 'global' | 'ephemeral'

export interface BrowserPreapproval {
  action: BrowserActionClass
  origin: string
}

export interface ProjectBrowserPolicy {
  projectId: string
  revision: number
  /** Written by a newer termul: shown, never edited. */
  readOnly: boolean
  /** Canonical entries: `https://example.com` or `https://*.example.com`. */
  allowList: string[]
  preapprovals: BrowserPreapproval[]
  /** What the project asks for. */
  profileMode: BrowserProfileMode
  /** What its agents get: ephemeral while the app switch is off or the system cannot keep a shared profile. */
  effectiveProfileMode: BrowserProfileMode
}

/** What clearing the global agent profile would close right now. */
export interface BrowserProfileClearImpact {
  sessions: number
  projects: number
}

export interface AppBrowserPolicy {
  revision: number
  readOnly: boolean
  globalProfileEnabled: boolean
  /** The switch is on and this system can keep a shared profile (macOS needs 14). */
  effectiveGlobalProfile: boolean
  /** Prompt before an agent submits a password. Off by default. */
  askBeforePasswordSubmit: boolean
  preapprovals: BrowserPreapproval[]
  clearImpact: BrowserProfileClearImpact
}

export type ProjectBrowserPolicyOp =
  | { op: 'add_origin'; origin: string }
  | { op: 'remove_origin'; origin: string }
  | { op: 'add_preapproval'; action: BrowserActionClass; origin: string }
  | { op: 'remove_preapproval'; action: BrowserActionClass; origin: string }
  | { op: 'set_ephemeral'; ephemeral: boolean }

export type AppBrowserPolicyOp =
  | { op: 'set_global_profile'; enabled: boolean }
  | { op: 'set_ask_before_password_submit'; enabled: boolean }
  | { op: 'add_preapproval'; action: BrowserActionClass; origin: string }
  | { op: 'remove_preapproval'; action: BrowserActionClass; origin: string }
  | { op: 'clear_global_profile' }

/** Frozen wire codes a policy reply can carry. */
export type BrowserPolicyCode = 'invalid_params' | 'capability_unavailable' | 'internal'

/** Finer causes behind a refusal, carried before the first `: ` of `error`. */
export type BrowserPolicyReason =
  | 'invalid_origin'
  | 'invalid_wildcard'
  | 'reserved_origin'
  | 'preapproval_not_allowed'
  | 'limit_exceeded'
  | 'malformed_operation'
  | 'invalid_project_id'
  | 'app_scope_required'
  | 'project_scope_mismatch'
  | 'revision_conflict'
  | 'policy_read_only'
  | 'policy_store_unavailable'
  | 'profile_engine_unavailable'
  | 'profile_clear_failed'
  | 'storage_failed'

/** `browser_policy_changed`: a hint to re-read one scope. */
export type BrowserPolicyChange =
  | { scope: 'app'; revision: number }
  | { scope: 'project'; projectId: string; revision: number }
