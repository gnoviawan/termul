import { useAcpStore } from '@/stores/acp-store'
import { isCodexSession } from '@/stores/codex-account-switch'
import { type ProjectCodexAccount, useProjectCodexAccount } from './use-project-codex-account'

/** The Codex Account of one chat; `null` when the chat is not a managed Codex chat. */
export function useChatCodexAccount(sessionId: string): ProjectCodexAccount | null {
  const isCodex = useAcpStore((s) => isCodexSession(s, sessionId))
  const projectId = useAcpStore((s) => s.sessions?.[sessionId]?.projectId ?? '')
  return useProjectCodexAccount(isCodex && projectId ? projectId : null)
}
