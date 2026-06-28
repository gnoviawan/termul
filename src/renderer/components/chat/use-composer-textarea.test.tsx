import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MentionMatch, MentionSection } from './mention-menu-model'
import type { ComposerMentions } from './use-composer-mentions'
import { useComposerTextarea } from './use-composer-textarea'

vi.mock('./mention-menu-keyboard', () => ({
  tryHandleMentionMenuKeyDown: vi.fn(() => false)
}))

const match: MentionMatch = {
  relPath: 'src/a.ts',
  absPath: '/work/src/a.ts',
  name: 'a.ts',
  ignored: false
}

function makeMentions(overrides: Partial<ComposerMentions> = {}): ComposerMentions {
  return {
    menuOpen: false,
    filter: '',
    sections: [] as MentionSection[],
    loading: false,
    menuRef: { current: null },
    update: vi.fn(),
    select: vi.fn(),
    reset: vi.fn(),
    ...overrides
  }
}

/** Minimal fake textarea — the hook only touches value/caret/style/scrollHeight/focus. */
function fakeTextarea(
  value: string,
  selectionStart: number,
  scrollHeight = 200
): HTMLTextAreaElement {
  return {
    value,
    selectionStart,
    style: { height: '' } as CSSStyleDeclaration,
    scrollHeight,
    setSelectionRange: vi.fn(),
    focus: vi.fn()
  } as unknown as HTMLTextAreaElement
}

interface RenderExtras {
  overrides?: Partial<Parameters<typeof useComposerTextarea>[0]>
}

function renderTextarea(mentions: ComposerMentions, initial = '', extras: RenderExtras = {}) {
  const setValue = vi.fn()
  const textareaRef = { current: null as HTMLTextAreaElement | null }
  const result = renderHook(() =>
    useComposerTextarea({
      value: initial,
      setValue,
      textareaRef: textareaRef as RefObject<HTMLTextAreaElement | null>,
      mentions,
      disabled: false,
      slashOpen: false,
      ...extras.overrides
    })
  )
  return { setValue, textareaRef, ...result }
}

describe('useComposerTextarea', () => {
  beforeEach(() => {
    // Run rAF callbacks synchronously so mention-select is testable without flushing.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('onInput syncs value, clamps height, and updates mentions', () => {
    const update = vi.fn()
    const { setValue, result } = renderTextarea(makeMentions({ update }))
    const el = fakeTextarea('hi @a', 5, 300)

    act(() => {
      result.current.onInput({
        currentTarget: el
      } as unknown as React.FormEvent<HTMLTextAreaElement>)
    })

    expect(setValue).toHaveBeenCalledWith('hi @a')
    expect(update).toHaveBeenCalledWith('hi @a', 5)
    expect(el.style.height).toBe('160px') // min(300, 160)
  })

  it('clampHeight caps at maxHeight and shrinks below it', () => {
    const { result } = renderTextarea(makeMentions(), '')
    const el = fakeTextarea('', 0, 300)
    act(() => result.current.clampHeight(el))
    expect(el.style.height).toBe('160px')
    ;(el as unknown as { scrollHeight: number }).scrollHeight = 40
    act(() => result.current.clampHeight(el))
    expect(el.style.height).toBe('40px')
  })

  it('resetHeight collapses the textarea to auto', () => {
    const { textareaRef, result } = renderTextarea(makeMentions(), '')
    const el = fakeTextarea('', 0)
    el.style.height = '123px'
    textareaRef.current = el
    act(() => result.current.resetHeight())
    expect(el.style.height).toBe('auto')
  })

  it('onMentionSelect splices, resets height, then clamps + restores caret + updates mentions', () => {
    const select = vi.fn(() => ({ value: 'hi ', caret: 3 }))
    const update = vi.fn()
    const { setValue, textareaRef, result } = renderTextarea(
      makeMentions({ select, update }),
      'hi @a'
    )
    const el = fakeTextarea('hi @a', 5, 300)
    textareaRef.current = el

    act(() => result.current.onMentionSelect(match))

    expect(select).toHaveBeenCalledWith('hi @a', 5, match)
    expect(setValue).toHaveBeenCalledWith('hi ')
    // resetHeight runs synchronously before the rAF clamp.
    expect(el.style.height).toBe('160px')
    expect(el.setSelectionRange).toHaveBeenCalledWith(3, 3)
    expect(el.focus).toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith('hi ', 3)
  })

  it('onMentionSelect is a no-op when select returns null', () => {
    const select = vi.fn(() => null)
    const update = vi.fn()
    const { setValue, result } = renderTextarea(makeMentions({ select, update }), 'hi @a')

    act(() => result.current.onMentionSelect(match))

    expect(select).toHaveBeenCalled()
    expect(setValue).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('derives mentionMenuOpen from menuOpen/disabled/slashOpen', () => {
    const { result: open } = renderTextarea(makeMentions({ menuOpen: true }), '')
    expect(open.current.mentionMenuOpen).toBe(true)

    const { result: disabled } = renderTextarea(makeMentions({ menuOpen: true }), '', {
      overrides: { disabled: true }
    })
    expect(disabled.current.mentionMenuOpen).toBe(false)

    const { result: slash } = renderTextarea(makeMentions({ menuOpen: true }), '', {
      overrides: { slashOpen: true }
    })
    expect(slash.current.mentionMenuOpen).toBe(false)
  })

  it('emptyLabel reflects the loading state', () => {
    const { result: idle } = renderTextarea(makeMentions({ loading: false }), '')
    expect(idle.current.emptyLabel).toBe('No matching files.')
    const { result: loading } = renderTextarea(makeMentions({ loading: true }), '')
    expect(loading.current.emptyLabel).toBe('Searching files…')
  })

  it('handleMentionKeyDown delegates to tryHandleMentionMenuKeyDown and returns its result', async () => {
    const { tryHandleMentionMenuKeyDown } = await import('./mention-menu-keyboard')
    const spy = vi.mocked(tryHandleMentionMenuKeyDown)
    spy.mockReturnValue(true)
    const { result } = renderTextarea(
      makeMentions({ menuOpen: true, sections: [{ id: 'f', heading: '', items: [] }] }),
      ''
    )
    const event = {} as React.KeyboardEvent<HTMLTextAreaElement>
    let handled = false
    act(() => {
      handled = result.current.handleMentionKeyDown(event)
    })
    expect(handled).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    const [, opts] = spy.mock.calls[0]
    expect(opts).toMatchObject({ menuOpen: true, sectionsLength: 1 })
    spy.mockReturnValue(false)
  })
})
