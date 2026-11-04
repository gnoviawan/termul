import type { ChatActivityRecord } from '@shared/types/web-protocol.types'
import { useChatActivityStore } from '@/stores/chat-activity-store'

/** A host `chat_activity` record: idle unless `overrides` say otherwise. */
export function chatActivityRecord(
  overrides: Partial<ChatActivityRecord> = {}
): ChatActivityRecord {
  return { busy: false, needsYou: false, unread: false, turnEnd: null, ...overrides }
}

/** Install what the host's `chat_activity` watch would hold, and the chats this renderer shows. */
export function seedChatActivity(
  sessions: Record<string, Partial<ChatActivityRecord>>,
  viewing: readonly string[] = []
): void {
  useChatActivityStore.setState({
    sessions: Object.fromEntries(
      Object.entries(sessions).map(([sessionId, record]) => [sessionId, chatActivityRecord(record)])
    ),
    viewing: [...viewing]
  })
}

export function resetChatActivity(): void {
  useChatActivityStore.setState({ sessions: {}, viewing: [] })
}
