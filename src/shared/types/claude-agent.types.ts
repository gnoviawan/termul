import type { IpcResult } from './ipc.types'

export type ClaudeAuthMode = 'claude-code' | 'api-key'

/** Credential-free host status for Claude Agent ACP. */
export interface ClaudeAuthStatus {
  authMode: ClaudeAuthMode
  apiKeyConfigured: boolean
  cliInstalled: boolean
  cliAuthenticated: boolean | null
}

/** Desktop-only host-keychain operations; never exposed over HTTP or WS. */
export interface ClaudeAgentApi {
  setupStatus(): Promise<IpcResult<ClaudeAuthStatus>>
  setAuthMode(mode: ClaudeAuthMode): Promise<IpcResult<void>>
  saveApiKey(key: string): Promise<IpcResult<void>>
  deleteApiKey(): Promise<IpcResult<void>>
}
