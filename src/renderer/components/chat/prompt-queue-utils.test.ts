import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@/lib/acp-api'
import { previewQueuedPrompt } from './prompt-queue-utils'

describe('prompt-queue-utils', () => {
  it('extracts preview text and image attachment from queued blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Check this screenshot' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'abc123',
        uri: 'file:///tmp/shot.png'
      }
    ]

    const preview = previewQueuedPrompt(blocks)
    expect(preview.text).toBe('Check this screenshot')
    expect(preview.attachments).toHaveLength(1)
    expect(preview.attachments[0]?.filename).toBeTruthy()
    expect(preview.attachments[0]?.isImage).toBe(true)
    expect(preview.attachments[0]?.url).toContain('data:image/png;base64,abc123')
  })
})
