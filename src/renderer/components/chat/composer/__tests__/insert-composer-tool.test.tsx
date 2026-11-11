import { act, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { toolToken } from '@/lib/composer/tool-tokens'
import { ChatComposerEditor } from '../ChatComposerEditor'
import { getComposerValue, setComposerCaret, setComposerValue } from '../chat-composer-test-helpers'
import { insertComposerTool } from '../insert-pill'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => undefined) }))

function Host(): React.JSX.Element {
  const [value, setValue] = useState('')
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

async function mount(): Promise<void> {
  render(<Host />)
  await waitFor(() => expect(editor()).toBeTruthy())
}

function insert(target: Editor | null): boolean {
  let ok = false
  act(() => {
    ok = insertComposerTool(target, 'browser')
  })
  return ok
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const el of Array.from(document.querySelectorAll('[data-composer-editor="true"]'))) {
    const instance = (el as HTMLElement & { __composerEditor?: Editor | null }).__composerEditor
    if (instance && !instance.isDestroyed) instance.destroy()
  }
})

describe('insertComposerTool', () => {
  it('adds a space before and after the pill between two words, then focuses the composer', async () => {
    await mount()
    setComposerValue('open please')
    setComposerCaret('open'.length)
    screen.getByRole('button', { name: 'Outside' }).focus()

    expect(insert(editor())).toBe(true)

    expect(getComposerValue()).toBe(`open ${toolToken('browser')} please`)
    expect(document.activeElement).toBe(editor().view.dom)
  })

  it('adds a trailing space at the end so typing continues after the pill', async () => {
    await mount()
    setComposerValue('use')
    setComposerCaret(3)
    insert(editor())
    expect(getComposerValue()).toBe(`use ${toolToken('browser')} `)
  })

  it('returns false when there is no editor', () => {
    expect(insert(null)).toBe(false)
  })

  it('returns false when the insert throws', async () => {
    await mount()
    vi.spyOn(editor().view, 'dispatch').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(insert(editor())).toBe(false)
  })
})
