import type { AutomationSuggestion } from '@shared/types/automation.types'
import { useEffect, useRef, useState } from 'react'
import { matchAutomationSuggestion } from '@/lib/automation-api'
import { useAcpStore } from '@/stores/acp-store'
import type { ChatMessage } from '@/stores/acp-store/types'
import { useSuggestAutomations } from '@/stores/app-settings-store'
import { isSnoozed, useSuggestionSnoozes } from './suggestion-snooze'
import { type SuggestionActions, useSuggestionActions } from './use-suggestion-actions'

/** A prompt this much older than the chat on screen is history, not a send. */
const SENT_SLACK_MS = 10_000

/** Chats that already showed a card; at most one per chat. */
const offeredChats = new Set<string>()

export function resetOfferedChatsForTests(): void {
  offeredChats.clear()
}

function lastUserMessage(messages: ChatMessage[] | undefined): ChatMessage | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i]
  }
  return null
}

function promptText(message: ChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n')
    .trim()
}

export interface ChatSuggestion extends SuggestionActions {
  suggestion: AutomationSuggestion
}

/**
 * After the user sends a prompt in this chat, ask the host whether it repeats
 * a suggestion; on a hit the chat shows one card. Nothing is asked while the
 * setting is off.
 */
export function useChatAutomationSuggestion(
  sessionId: string,
  projectId: string | undefined
): ChatSuggestion | null {
  const enabled = useSuggestAutomations()
  const lastUserId = useAcpStore((s) => lastUserMessage(s.messages[sessionId])?.id ?? null)
  const snoozes = useSuggestionSnoozes((s) => s.until)
  const [suggestion, setSuggestion] = useState<AutomationSuggestion | null>(null)
  const mountedAt = useRef(Date.now())
  const matched = useRef<string | null>(null)
  // A launch swaps the placeholder session id for the real one: still one chat.
  const offered = useRef(false)
  const actions = useSuggestionActions(projectId ?? '', () => setSuggestion(null))

  useEffect(() => {
    if (!enabled || !projectId || !lastUserId || matched.current === lastUserId) return
    if (offered.current || offeredChats.has(sessionId)) return
    matched.current = lastUserId
    const message = lastUserMessage(useAcpStore.getState().messages[sessionId])
    if (!message || message.timestamp < mountedAt.current - SENT_SLACK_MS) return
    const text = promptText(message)
    if (!text) return
    let current = true
    void matchAutomationSuggestion(projectId, text).then((result) => {
      if (!current || !result.success || !result.data) return
      const { until } = useSuggestionSnoozes.getState()
      if (isSnoozed(until, projectId, result.data.fingerprint)) return
      offered.current = true
      offeredChats.add(sessionId)
      setSuggestion(result.data)
    })
    return () => {
      current = false
    }
  }, [enabled, projectId, sessionId, lastUserId])

  if (!enabled || !projectId || !suggestion) return null
  if (isSnoozed(snoozes, projectId, suggestion.fingerprint)) return null
  return { suggestion, ...actions }
}
