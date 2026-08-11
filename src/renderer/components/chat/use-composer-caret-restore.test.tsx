import { act, renderHook } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { Schema } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { MutableRefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { activeMentionToken, type MentionMatch } from './mention-menu-model'
import { useComposerMentionSelect } from './use-composer-caret-restore'

describe('useComposerMentionSelect', () => {
  it('uses the active caret within an @ token for a backward selection', () => {
    const value = 'prefix @auth suffix'
    const schema = new Schema({
      nodes: {
        doc: { content: 'paragraph+' },
        paragraph: { content: 'text*' },
        text: { inline: true }
      }
    })
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text(value))])
    const selection = TextSelection.create(doc, 19, 11)
    const editorRef = {
      current: {
        state: {
          doc,
          selection
        }
      } as unknown as Editor
    } satisfies MutableRefObject<Editor | null>
    const select = vi.fn(() => null)
    const match: MentionMatch = {
      relPath: 'src/auth.ts',
      absPath: '/work/src/auth.ts',
      name: 'auth.ts',
      ignored: false
    }
    const { result } = renderHook(() =>
      useComposerMentionSelect({
        value,
        setValue: vi.fn(),
        editorRef,
        mentions: { select, update: vi.fn() },
        scheduleRestoreCaret: vi.fn()
      })
    )

    act(() => result.current(match))

    expect(select).toHaveBeenCalledWith(value, 10, match)
    expect(activeMentionToken(value, select.mock.calls[0][1])).toMatchObject({
      at: 7,
      end: 12
    })
  })
})
