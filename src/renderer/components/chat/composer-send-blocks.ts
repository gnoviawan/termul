import type { ContentBlock } from '@/lib/acp-api'
import {
  attachmentToBlock,
  dedupeAttachmentBlocks,
  type PendingAttachment
} from './chat-attachments'
import type { ChatPromptParts } from './use-chat-composer'

export type ComposerSend =
  | { kind: 'text'; text: string }
  | { kind: 'blocks'; wire: ContentBlock[]; display?: ContentBlock[] }

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
