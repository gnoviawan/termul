import { act, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { displayOffsetToDocOffset, docOffsetToDisplayOffset } from '@/lib/composer/doc-to-prompt'
import {
  createSelectionContext,
  type SelectionContext,
  selectionContextToken
} from '@/lib/composer/selection-context'
import { ChatComposerEditor } from '../ChatComposerEditor'
import {
  getComposerValue,
  pressComposerKey,
  setComposerCaret,
  setComposerValue
} from '../chat-composer-test-helpers'
import { insertSelectionContext } from '../insert-selection-context'

function ctx(text: string, language?: string): SelectionContext {
  const context = createSelectionContext(text, language)
  if (!context) throw new Error('empty context')
  return context
}

function Host({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <TooltipProvider>
      <ChatComposerEditor value={value} onValueChange={setValue} ariaLabel="Composer" />
      <button type="button">Outside</button>
    </TooltipProvider>
  )
}

function editor(): Editor {
  const el = document.querySelector('[data-composer-editor="true"]') as
    | (HTMLElement & { __composerEditor?: Editor | null })
    | null
  const instance = el?.__composerEditor
  if (!instance) throw new Error('editor not mounted')
  return instance
}

function insert(context: SelectionContext): boolean {
  let ok = false
  act(() => {
    ok = insertSelectionContext(editor(), context)
  })
  return ok
}

function chipLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-context-pill] [role="note"]')).map(
    (el) => el.getAttribute('aria-label') ?? ''
  )
}

function caretDisplayOffset(): number {
  const e = editor()
  return docOffsetToDisplayOffset(e.state.doc, e.state.selection.to)
}

async function mount(initial = ''): Promise<void> {
  render(<Host initial={initial} />)
  await waitFor(() => expect(editor()).toBeTruthy())
}

afterEach(() => {
  for (const el of Array.from(document.querySelectorAll('[data-composer-editor="true"]'))) {
    const instance = (el as HTMLElement & { __composerEditor?: Editor | null }).__composerEditor
    if (instance && !instance.isDestroyed) instance.destroy()
  }
})

describe('selection context pill in the composer', () => {
  it('inserts an inline chip at the caret, then focuses the composer with the caret after it', async () => {
    await mount()
    setComposerValue('explain please')
    setComposerCaret('explain'.length)
    screen.getByRole('button', { name: 'Outside' }).focus()

    expect(insert(ctx('const a = 1', 'ts'))).toBe(true)

    const token = selectionContextToken(ctx('const a = 1', 'ts'))
    expect(getComposerValue()).toBe(`explain ${token} please`)
    expect(document.activeElement).toBe(editor().view.dom)
    expect(caretDisplayOffset()).toBe(`explain ${token}`.length)
    expect(chipLabels()).toEqual(['Context 1: const a = 1'])
  })

  it('adds a trailing space when the caret is at the end, so typing continues after the chip', async () => {
    await mount()
    setComposerValue('see')
    setComposerCaret(3)
    insert(ctx('quoted'))
    const token = selectionContextToken(ctx('quoted'))
    expect(getComposerValue()).toBe(`see ${token} `)
    expect(caretDisplayOffset()).toBe(getComposerValue().length)
  })

  it('replaces a select-all selection with the chip in one paragraph, then keeps chip order', async () => {
    await mount()
    setComposerValue('old draft')
    act(() => {
      editor().commands.selectAll()
    })
    insert(ctx('first'))
    insert(ctx('second'))
    const first = selectionContextToken(ctx('first'))
    const second = selectionContextToken(ctx('second'))
    expect(getComposerValue()).toBe(`${first} ${second} `)
    expect(editor().state.doc.childCount).toBe(1)
    expect(chipLabels()).toEqual(['Context 1: first', 'Context 2: second'])
  })

  it('inserts into an emptied composer after select-all + delete without a stray paragraph', async () => {
    await mount()
    setComposerValue('old draft')
    act(() => {
      editor().commands.selectAll()
    })
    act(() => {
      editor().commands.deleteSelection()
    })
    act(() => {
      editor().commands.selectAll()
    })
    insert(ctx('only'))
    expect(getComposerValue()).toBe(`${selectionContextToken(ctx('only'))} `)
    expect(editor().state.doc.childCount).toBe(1)
    expect(caretDisplayOffset()).toBe(getComposerValue().length)
  })

  it('numbers several chips by their order and renumbers when one is removed', async () => {
    await mount()
    insert(ctx('first'))
    insert(ctx('second'))
    expect(chipLabels()).toEqual(['Context 1: first', 'Context 2: second'])

    const first = selectionContextToken(ctx('first'))
    setComposerCaret(first.length + 1)
    pressComposerKey('Backspace')

    await waitFor(() => expect(chipLabels()).toEqual(['Context 1: second']))
  })

  it('removes the whole chip and its trailing space with one Backspace, like other pills', async () => {
    await mount()
    setComposerValue('a ')
    setComposerCaret(2)
    insert(ctx('quoted'))
    expect(getComposerValue()).toBe(`a ${selectionContextToken(ctx('quoted'))} `)

    pressComposerKey('Backspace')

    expect(getComposerValue()).toBe('a ')
    expect(chipLabels()).toEqual([])
  })

  it('restores chips from a saved draft and clears them with the rest of the composer', async () => {
    const token = selectionContextToken(ctx('line 1\nline 2'))
    await mount(`look ${token} now`)
    expect(chipLabels()).toEqual(['Context 1: line 1 line 2'])

    setComposerValue('')

    expect(getComposerValue()).toBe('')
    expect(chipLabels()).toEqual([])
  })

  it('maps display offsets across a chip as one atom', async () => {
    const token = selectionContextToken(ctx('x'))
    await mount(`a${token}b`)
    const doc = editor().state.doc
    expect(displayOffsetToDocOffset(doc, 1 + token.length)).toBe(3)
    expect(docOffsetToDisplayOffset(doc, 3)).toBe(1 + token.length)
  })

  it('refuses to insert into a destroyed editor and reports failure', async () => {
    await mount()
    const instance = editor()
    act(() => instance.destroy())
    expect(insertSelectionContext(instance, ctx('x'))).toBe(false)
  })
})
