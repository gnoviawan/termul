import type { BrowserActionClass } from '@shared/types/browser-policy.types'
import type { BrowserPolicyFailure } from '@/lib/browser-policy-api'

export const ACTION_LABELS: Record<BrowserActionClass, string> = {
  navigate: 'Open a site',
  local_network: 'Open a local network address',
  password_submit: 'Submit a password form',
  payment_submit: 'Submit a payment form',
  upload: 'Upload a file',
  download: 'Download a file',
  tainted_exfil: 'Send page data to another site'
}

const REASON_COPY: Partial<Record<NonNullable<BrowserPolicyFailure['reason']>, string>> = {
  invalid_origin: 'Enter an http or https address such as https://example.com.',
  invalid_wildcard: 'Use * only as the first part of the host, as in https://*.example.com.',
  reserved_origin: "Termul's own addresses and local-only addresses can't be allowed.",
  preapproval_not_allowed: "This action can't be pre-approved here.",
  limit_exceeded: 'The list is full. Remove an entry first.',
  malformed_operation: 'Termul could not read that change.',
  invalid_project_id: 'This project is not available.',
  app_scope_required: 'This device can only change the rules for its own project.',
  project_scope_mismatch: 'This device is connected to a different project.',
  revision_conflict: 'The rules kept changing. Reload and try again.',
  policy_read_only:
    'These rules were saved by a newer version of Termul, or their file is damaged. You can read them but not change them.',
  policy_store_unavailable: "Browser rules aren't available on this host.",
  profile_engine_unavailable: "This build can't clear the agent browser profile yet.",
  profile_clear_failed: 'The agent browser profile could not be cleared. Try again.',
  storage_failed: 'The change could not be saved. Try again.'
}

/** One sentence for a failed policy read or edit. */
export function describeFailure(failure: BrowserPolicyFailure): string {
  if (failure.reason) return REASON_COPY[failure.reason] ?? failure.message
  if (failure.code === 'NETWORK_ERROR') return 'Could not reach the host. Check the connection.'
  if (failure.code === 'UNAUTHORIZED') return 'Sign in again to change browser rules.'
  return failure.message
}

/** Row ids that settings search jumps to. */
export const BROWSER_ANCHORS = {
  appProfile: 'setting-browser-shared-profile',
  appPasswordPrompt: 'setting-browser-password-prompt',
  appPreapprovals: 'setting-browser-app-preapprovals',
  appClear: 'setting-browser-clear-profile',
  projectEphemeral: 'setting-browser-ephemeral',
  projectAllowList: 'setting-browser-allow-list',
  projectPreapprovals: 'setting-browser-project-preapprovals'
} as const
