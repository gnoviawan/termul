import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'

export type CodexCliAuthState = 'signed-in' | 'signed-out' | 'unavailable'

export type CodexAuthSyncAction = 'none' | 'refresh-after-cli-logout' | 'refresh-after-cli-login'

/** Shown on an open Codex chat after `codex logout`. */
export const CODEX_CLI_SIGNED_OUT_MESSAGE = 'Codex signed out. Sign in again to continue this chat.'

const CODEX_ACP_PACKAGES = ['@agentclientprotocol/codex-acp', '@zed-industries/codex-acp'] as const

/** Exact package or binary token. A path that merely contains the name does not match. */
function isCodexPackageArg(arg: string): boolean {
  if (arg === 'codex-acp') return true
  return CODEX_ACP_PACKAGES.some((pkg) => arg === pkg || arg.startsWith(`${pkg}@`))
}

export function isCodexAcpConfig(config: {
  id?: string
  templateId?: string
  args?: string[]
}): boolean {
  if (config.templateId === 'codex-acp') return true
  if (config.id === 'codex-acp' || config.id === 'acp-registry:codex-acp') return true
  return (config.args ?? []).some(isCodexPackageArg)
}

export function codexHomeFromConfig(
  config: Pick<StoredAgentConfig, 'env'> | undefined
): string | null {
  const home = config?.env?.CODEX_HOME?.trim()
  return home ? home : null
}

/**
 * Decide whether a Codex CLI login change should restart the Termul Codex agent.
 * The first sample only records the state. A later change follows `codex login status`.
 */
export function codexAuthSyncDecision(input: {
  previous: CodexCliAuthState | null
  next: CodexCliAuthState
  authBusy: boolean
  hasLiveAgent: boolean
  hasAuthError: boolean
}): { previous: CodexCliAuthState | null; action: CodexAuthSyncAction } {
  if (input.next === 'unavailable' || input.authBusy) {
    return { previous: input.previous, action: 'none' }
  }
  if (input.previous === null || input.previous === input.next) {
    return { previous: input.next, action: 'none' }
  }
  if (input.next === 'signed-out') {
    return {
      previous: input.next,
      action: input.hasLiveAgent ? 'refresh-after-cli-logout' : 'none'
    }
  }
  if (input.hasAuthError) {
    return { previous: input.next, action: 'refresh-after-cli-login' }
  }
  return { previous: input.next, action: 'none' }
}
