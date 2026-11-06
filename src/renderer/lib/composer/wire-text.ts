import { conversationWireLabel } from '@/lib/conversation-envelope'
import type { ConversationContexts } from '@/lib/conversation-transcript'
import {
  replaceCommandTokensInline,
  replaceConversationTokensInline,
  replaceFileTokensInline
} from '@/lib/skill-tokens'
import { type FramedSkill, formatPromptWithSkills } from '@/lib/skills-prompt'
import { serializeSelectionContexts } from './selection-context'

/**
 * The text the agent receives for a composer value (sentinel-token format).
 * Every pill becomes plain text where the user placed it, so no private-use
 * sentinel reaches the wire. Shared by the composer send and the chat's
 * Retry, which re-frames the last user message from its display text.
 *
 * `contexts` is the resolved conversation transcripts; without it every
 * mentioned conversation is labelled as unavailable.
 */
export function composerWireText(
  value: string,
  skills: FramedSkill[],
  contexts?: ConversationContexts
): string {
  // Selection contexts become the leading quote blocks first, while a leading
  // command token is still recognizable.
  const withCommands = replaceCommandTokensInline(serializeSelectionContexts(value))
  const plain = replaceConversationTokensInline(
    replaceFileTokensInline(withCommands),
    (title, sessionId) =>
      conversationWireLabel(
        title,
        sessionId,
        contexts === undefined ? 'unavailable' : (contexts.gaps.get(sessionId) ?? null)
      )
  )
  return formatPromptWithSkills(skills, plain)
}
