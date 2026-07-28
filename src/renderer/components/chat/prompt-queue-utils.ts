import type { ContentBlock } from '@/lib/acp-api'
import {
  blockData,
  blockDisplayName,
  blockMimeType,
  blockToAttachmentData,
  blockUri
} from './chat-attachments'

export interface QueueAttachmentPreview {
  id: string
  filename: string
  url: string
  mediaType: string
  isImage: boolean
}

export interface QueueItemPreview {
  text: string
  attachments: QueueAttachmentPreview[]
}

/** Build queue-row preview text + attachment chips from ACP content blocks. */
export function previewQueuedPrompt(blocks: ContentBlock[]): QueueItemPreview {
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim()

  const attachments: QueueAttachmentPreview[] = []
  for (const block of blocks) {
    if (block.type === 'text') continue
    const id = `${block.type}-${attachments.length}`
    const data = blockToAttachmentData(block, id)
    const mediaType = blockMimeType(block) ?? data.mediaType ?? 'application/octet-stream'
    let url = data.url ?? ''
    if (!url && block.type === 'image') {
      const payload = blockData(block)
      if (payload) url = `data:${mediaType};base64,${payload}`
    }
    if (!url) {
      const uri = blockUri(block)
      if (uri?.startsWith('data:') || uri?.startsWith('http')) url = uri
    }
    attachments.push({
      id,
      filename: blockDisplayName(block),
      url,
      mediaType,
      isImage: mediaType.startsWith('image/')
    })
  }

  return { text, attachments }
}
