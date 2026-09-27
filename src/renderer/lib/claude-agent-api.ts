import { createTauriClaudeAgentApi } from './tauri-claude-agent-api'

/** Claude auth management is local to the desktop host by design. */
export const claudeAgentApi = createTauriClaudeAgentApi()
