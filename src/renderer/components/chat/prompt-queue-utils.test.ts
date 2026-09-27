import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@/lib/acp-api'
import { commandToken, fileToken, skillToken } from '@/lib/skill-tokens'
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

  it('renders readable /name text for queued command tokens (no sentinels)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: `${commandToken('compact')} summarize this` }
    ]

    const preview = previewQueuedPrompt(blocks)
    expect(preview.text).toBe('/compact summarize this')
    // No private-use sentinel leaks into the queue row.
    expect(preview.text).not.toMatch(/[\uE000-\uE007]/)
  })

  it('renders readable (skill)/(file)/cmd text when all pill tokens are queued', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: `${commandToken('compact')} use ${skillToken('git-worktree')} on ${fileToken('auth.ts', '/work/src/auth.ts')}`
      }
    ]

    const preview = previewQueuedPrompt(blocks)
    expect(preview.text).toBe('/compact use (git-worktree) on (auth.ts)')
    expect(preview.text).not.toMatch(/[\uE000-\uE007]/)
  })
})
