import type {
  ClaudeAgentApi,
  ClaudeAuthMode,
  ClaudeAuthStatus
} from '@shared/types/claude-agent.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from './tauri-runtime'

async function invokeIpc<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

function unsupported<T>(command: string): IpcResult<T> {
  return {
    success: false,
    error: `${command} requires the Termul desktop runtime`,
    code: 'UNSUPPORTED'
  }
}

export function createTauriClaudeAgentApi(): ClaudeAgentApi {
  return {
    setupStatus: async () =>
      isTauriContext()
        ? invokeIpc<ClaudeAuthStatus>('acp_claude_setup_status')
        : unsupported('acp_claude_setup_status'),
    setAuthMode: async (mode: ClaudeAuthMode) =>
      isTauriContext()
        ? invokeIpc<void>('acp_claude_set_auth_mode', { mode })
        : unsupported('acp_claude_set_auth_mode'),
    saveApiKey: async (key: string) =>
      isTauriContext()
        ? invokeIpc<void>('acp_claude_save_api_key', { key })
        : unsupported('acp_claude_save_api_key'),
    deleteApiKey: async () =>
      isTauriContext()
        ? invokeIpc<void>('acp_claude_delete_api_key')
        : unsupported('acp_claude_delete_api_key')
  }
}
