/**
 * Sign a Codex Account in with ACP `authenticate` on an agent whose
 * `CODEX_HOME` is that Account. `chat-gpt` opens the browser flow.
 * `chat-gpt-device-code` shows a code the user can enter on any device.
 * Both work on the desktop app and on a remote browser. API-key auth is not
 * offered.
 */

import {
  CODEX_AGENT_CONFIG_ID,
  CODEX_CHATGPT_METHOD,
  CODEX_DEVICE_CODE_METHOD
} from '@shared/types/codex-accounts.types'
import type { AgentConfig } from '@/lib/acp-api'
import { isCodexAcpConfig } from '@/lib/agents/codex-cli-auth'
import { codexAccountsApi } from '@/lib/codex-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { useAcpStore } from '@/stores/acp-store'

export const CODEX_SIGN_IN_METHODS = [
  { id: CODEX_CHATGPT_METHOD, label: 'Sign in with ChatGPT' },
  { id: CODEX_DEVICE_CODE_METHOD, label: 'Use a device code' }
] as const

export function isCodexSignInMethod(methodId: string): boolean {
  return methodId === CODEX_CHATGPT_METHOD || methodId === CODEX_DEVICE_CODE_METHOD
}

function codexLaunchConfig(): AgentConfig {
  const stored = useAcpStore
    .getState()
    .agentConfigs.find((config) => config.id === CODEX_AGENT_CONFIG_ID || isCodexAcpConfig(config))
  if (!stored) {
    throw new Error('The Codex agent is not set up on this host.')
  }
  return {
    configId: CODEX_AGENT_CONFIG_ID,
    name: stored.name,
    command: stored.command,
    args: stored.args ?? [],
    env: { ...(stored.env ?? {}) },
    allowTerminal: stored.allowTerminal
  }
}

/**
 * Spawn, authenticate, then stop the sign-in agent. The ChatGPT login stays
 * in the Account home. The global sign-in dialog shows a URL or a device code
 * while `authenticate` waits.
 */
export async function signInCodexAccount(accountId: string, methodId: string): Promise<void> {
  if (!isCodexSignInMethod(methodId)) {
    throw new Error('Codex accounts sign in with ChatGPT only.')
  }
  const config = codexLaunchConfig()
  const result = await codexAccountsApi.startLogin(accountId, config)
  useAcpStore.setState((state) => ({
    agents: {
      ...state.agents,
      [result.agentId]: {
        id: result.agentId,
        capabilities: result.capabilities ?? null,
        authMethods: result.authMethods ?? [],
        hostAuthReady: false
      }
    },
    agentStatus: { ...state.agentStatus, [result.agentId]: 'connected' }
  }))
  try {
    await useAcpStore.getState().authenticateAgent(result.agentId, methodId)
    void logFrontendError({
      level: 'info',
      source: 'codexAccounts.signIn',
      message: `Codex account ${accountId} finished ChatGPT sign-in`
    })
  } finally {
    await useAcpStore
      .getState()
      .killAgent(result.agentId)
      .catch(() => undefined)
  }
}
