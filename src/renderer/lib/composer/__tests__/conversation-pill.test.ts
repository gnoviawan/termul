import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { ConversationPill } from '@/components/chat/composer/ConversationPillNode'
import { FilePill } from '@/components/chat/composer/FilePillNode'
import { CONVERSATION_PILL_NODE, docToDisplayText } from '@/lib/composer/doc-to-prompt'
import { draftFromTokens } from '@/lib/composer/draft-from-tokens'
import { conversationToken, fileToken } from '@/lib/skill-tokens'

const schema = getSchema([StarterKit, FilePill, ConversationPill])
const roundTrip = (value: string): string =>
  docToDisplayText(schema.nodeFromJSON(draftFromTokens(value)))

describe('conversation pill in the composer doc', () => {
  it('parses a conversation token into a pill node that keeps the title and id', () => {
    const token = conversationToken('Fix web reconnect', 'sess-1')
    expect(draftFromTokens(`compare ${token} please`)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'compare ' },
            {
              type: CONVERSATION_PILL_NODE,
              attrs: { title: 'Fix web reconnect', sessionId: 'sess-1' }
            },
            { type: 'text', text: ' please' }
          ]
        }
      ]
    })
  })

  it('round-trips a value with conversation and file pills back to the same string', () => {
    const value = `see ${conversationToken('Status pill tabs', 'sess-2')} and ${fileToken('a.ts', '/w/a.ts')} `
    expect(roundTrip(value)).toBe(value)
  })

  it('still renders the pill from the token title when the chat no longer exists', () => {
    const value = conversationToken('Deleted chat', 'gone-id')
    expect(roundTrip(value)).toBe(value)
  })
})
