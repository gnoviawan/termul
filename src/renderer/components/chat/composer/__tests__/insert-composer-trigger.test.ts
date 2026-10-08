import { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { docToDisplayText } from '@/lib/composer/doc-to-prompt'
import { blurComposerEditor, insertComposerTrigger } from '../insert-composer-trigger'

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn(async () => {}) }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogError }))

const editors: Editor[] = []

function makeEditor(content = ''): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit],
    content: content ? `<p>${content}</p>` : ''
  })
  editors.push(editor)
  return editor
}

function draft(editor: Editor): string {
  return docToDisplayText(editor.state.doc)
}

beforeEach(() => {
  mockLogError.mockClear()
})

afterEach(() => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) editor.destroy()
  }
  document.body.innerHTML = ''
})

describe('insertComposerTrigger', () => {
  it.each([
    ['', '@', '@'],
    ['', '/', '/'],
    ['fix the bug', '@', 'fix the bug @'],
    ['hello', '/', 'hello /']
  ] as const)('turns draft %j plus %s into %j', (initial, trigger, expected) => {
    const editor = makeEditor(initial)

    expect(insertComposerTrigger(editor, trigger)).toBe(true)

    expect(draft(editor)).toBe(expected)
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it('keeps a single space when the draft already ends in whitespace', () => {
    const editor = makeEditor('fix')
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' ')
    expect(draft(editor)).toBe('fix ')

    expect(insertComposerTrigger(editor, '@')).toBe(true)

    expect(draft(editor)).toBe('fix @')
  })

  it('moves the caret to the end and focuses the editor synchronously', () => {
    const editor = makeEditor('one two')
    editor.commands.setTextSelection(1)

    expect(insertComposerTrigger(editor, '/')).toBe(true)

    expect(editor.view.dom).toHaveFocus()
    expect(draft(editor)).toBe('one two /')
    // The caret sits right after the inserted trigger.
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.to).toBe(editor.state.doc.content.size - 1)
  })

  it('scrolls the caret into view in a transaction after the insertion', () => {
    const editor = makeEditor('a long draft')
    const dispatched: Transaction[] = []
    const realDispatch = editor.view.dispatch.bind(editor.view)
    const dispatch = vi.spyOn(editor.view, 'dispatch').mockImplementation((tr) => {
      dispatched.push(tr)
      realDispatch(tr)
    })

    expect(insertComposerTrigger(editor, '@')).toBe(true)

    dispatch.mockRestore()
    const insertion = dispatched.findIndex((tr) => tr.docChanged)
    const scroll = dispatched.findIndex((tr) => tr.scrolledIntoView)
    expect(insertion).toBeGreaterThanOrEqual(0)
    // The scroll rides its own transaction, after the insertion was emitted.
    expect(scroll).toBeGreaterThan(insertion)
    expect(dispatched[scroll].docChanged).toBe(false)
  })

  it('keeps the insertion and reports success when the view cannot scroll', () => {
    const editor = makeEditor('hello')
    const realDispatch = editor.view.dispatch.bind(editor.view)
    const dispatch = vi.spyOn(editor.view, 'dispatch').mockImplementation((tr) => {
      if (tr.scrolledIntoView) throw new Error('no layout')
      realDispatch(tr)
    })

    expect(insertComposerTrigger(editor, '/')).toBe(true)

    dispatch.mockRestore()
    expect(draft(editor)).toBe('hello /')
    expect(mockLogError).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', () => null],
    [
      'destroyed',
      () => {
        const editor = makeEditor('keep')
        editor.destroy()
        return editor
      }
    ],
    [
      'not editable',
      () => {
        const editor = makeEditor('keep')
        editor.setEditable(false)
        return editor
      }
    ]
  ])('returns false and logs one warning when the editor is %s', (_label, build) => {
    expect(insertComposerTrigger(build(), '@')).toBe(false)

    expect(mockLogError).toHaveBeenCalledTimes(1)
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'composer-add-sheet' })
    )
  })

  it('returns false, leaves the draft alone and never logs the draft when the insertion throws', () => {
    const editor = makeEditor('secret draft')
    // Only the insertion throws; focus handlers dispatch their own transactions.
    const realDispatch = editor.view.dispatch.bind(editor.view)
    const dispatch = vi.spyOn(editor.view, 'dispatch').mockImplementation((tr) => {
      if (tr.docChanged) throw new RangeError('Invalid content near "secret draft"')
      realDispatch(tr)
    })

    expect(insertComposerTrigger(editor, '@')).toBe(false)

    dispatch.mockRestore()
    expect(draft(editor)).toBe('secret draft')
    expect(mockLogError).toHaveBeenCalledTimes(1)
    const [payload] = mockLogError.mock.calls[0] as unknown as [{ message: string; stack?: string }]
    expect(payload).toMatchObject({ level: 'warn', source: 'composer-add-sheet' })
    expect(payload.message).toContain('RangeError')
    expect(payload.message).not.toContain('secret')
    expect(payload.stack).toBeUndefined()
  })
})

describe('blurComposerEditor', () => {
  it('blurs a focused editor', () => {
    const editor = makeEditor('x')
    editor.view.focus()
    expect(editor.view.dom).toHaveFocus()

    blurComposerEditor(editor)

    expect(editor.view.dom).not.toHaveFocus()
  })

  it('is a no-op for a missing or destroyed editor', () => {
    const destroyed = makeEditor('x')
    destroyed.destroy()

    expect(() => blurComposerEditor(null)).not.toThrow()
    expect(() => blurComposerEditor(destroyed)).not.toThrow()
  })
})
