import type { ContentBlock } from '@/lib/acp-api'
import {
  attachmentToBlock,
  dedupeAttachmentBlocks,
  type PendingAttachment
} from './chat-attachments'
import type { ChatPromptParts } from './use-chat-composer'

/** What the running-chat composer dispatches for one send. */
export type ComposerSend =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; wire: ContentBlock[]; display?: ContentBlock[] }

/**
 * Assemble the wire and display blocks for a send, or null when there is
 * nothing to send. Any pill (skill, file, command, selection context,
 * conversation) splits display from wire: the display keeps the raw tokens so
 * the timeline renders chips, and only the wire carries `resource_link` and
 * conversation transcript blocks.
 */
export function buildComposerSend(
  parts: ChatPromptParts,
  attachments: readonly PendingAttachment[]
): ComposerSend | null {
  const {
    hasSkills,
    hasCommand,
    hasSelectionContexts,
    hasConversations,
    wireWithCommand,
    displayWithCommand,
    wireTrimmed,
    displayTrimmed,
    fileBlocks,
    contextBlocks
  } = parts
  const hasFileRefs = fileBlocks.length > 0
  if (!wireTrimmed && attachments.length === 0 && !hasFileRefs) return null

  if (attachments.length > 0) {
    const wireBlocks: ContentBlock[] = []
    if (wireTrimmed) wireBlocks.push({ type: 'text', text: wireWithCommand })
    for (const a of attachments) wireBlocks.push(attachmentToBlock(a))
    wireBlocks.push(...fileBlocks, ...contextBlocks)
    const wire = dedupeAttachmentBlocks(wireBlocks)
    if (!(hasSkills || hasFileRefs || hasCommand || hasSelectionContexts || hasConversations)) {
      return { kind: 'blocks', wire }
    }
    const displayBlocks: ContentBlock[] = []
    if (displayTrimmed) displayBlocks.push({ type: 'text', text: displayWithCommand })
    for (const a of attachments) displayBlocks.push(attachmentToBlock(a))
    return { kind: 'blocks', wire, display: dedupeAttachmentBlocks(displayBlocks) }
  }
  if (hasSkills || hasFileRefs || hasConversations) {
    const wireBlocks: ContentBlock[] = wireTrimmed ? [{ type: 'text', text: wireWithCommand }] : []
    wireBlocks.push(...fileBlocks, ...contextBlocks)
    return {
      kind: 'blocks',
      wire: dedupeAttachmentBlocks(wireBlocks),
      display: displayTrimmed ? [{ type: 'text', text: displayWithCommand }] : []
    }
  }
  if (hasCommand || hasSelectionContexts) {
    return {
      kind: 'blocks',
      wire: wireTrimmed ? [{ type: 'text', text: wireTrimmed }] : [],
      display: displayTrimmed ? [{ type: 'text', text: displayTrimmed }] : []
    }
  }
  return { kind: 'text', text: wireTrimmed }
}
