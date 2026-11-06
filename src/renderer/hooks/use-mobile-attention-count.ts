import { useAgentChatProjectSignals } from './use-agent-chat-attention'

/**
 * Chats in the active project that need the user, excluding the chat on
 * screen, so the mobile header pill never reports the chat the user is
 * already looking at. Reads the same signals as the rail and the status bar.
 */
export function useMobileAttentionCount(
  activeProjectId: string | undefined,
  activeSessionId: string | null
): number {
  const { attentionCounts, needsYouChats } = useAgentChatProjectSignals()
  if (!activeProjectId) return 0
  const onScreen =
    activeSessionId !== null && needsYouChats.get(activeSessionId) === activeProjectId
  return (attentionCounts[activeProjectId] ?? 0) - (onScreen ? 1 : 0)
}
