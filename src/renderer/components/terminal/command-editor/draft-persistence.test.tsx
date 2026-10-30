import type { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createCommandDraftStore } from '@/lib/command-lifecycle/draft-store'

const androidChrome126 =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const geometryMethods = ['getClientRects', 'getBoundingClientRect'] as const
const originalGeometry = geometryMethods.map((name) =>
  Object.getOwnPropertyDescriptor(Range.prototype, name)
)
const originalUserAgent = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')

beforeAll(() => {
  // jsdom has no layout; CodeMirror still needs the Range geometry API.
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => []
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect()
  })
  // browser.android / chrome_version are read when @codemirror/view loads.
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => androidChrome126
  })
})

afterAll(() => {
  geometryMethods.forEach((name, index) => {
    const original = originalGeometry[index]
    if (original) Object.defineProperty(Range.prototype, name, original)
    else delete Range.prototype[name]
  })
  if (originalUserAgent) Object.defineProperty(Navigator.prototype, 'userAgent', originalUserAgent)
  else delete (navigator as { userAgent?: string }).userAgent
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    get: () => androidChrome126
  })
})

function controlFrames() {
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextId, callback)
    return nextId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id)
  })
  return () => {
    const pending = [...callbacks.values()]
    callbacks.clear()
    act(() => {
      for (const callback of pending) callback(performance.now())
    })
  }
}

async function mountEditor(
  initialDraft = 'ls',
  draftStore = createCommandDraftStore(),
  seed = true
) {
  vi.resetModules()
  const { CommandEditor } = await import('./CommandEditor')
  const { EditorView } = await import('@codemirror/view')
  const { StateEffect } = await import('@codemirror/state')
  if (seed) draftStore.offer('ime', 'Editor', initialDraft)
  const offer = vi.spyOn(draftStore, 'offer')
  const viewRef: { current: EditorView | null } = { current: null }
  const mounted = render(
    <CommandEditor terminalId="ime" focused={true} viewRef={viewRef} draftStore={draftStore} />
  )
  const view = viewRef.current!
  const events: string[] = []
  act(() => {
    view.dispatch({
      selection: { anchor: initialDraft.length },
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            if (transaction.isUserEvent('input.type.compose'))
              events.push(view.state.doc.toString())
          }
        })
      )
    })
  })
  return { ...mounted, view, draftStore, offer, events }
}

function replaceDOMText(view: EditorView, text: string) {
  const node = view.contentDOM.querySelector('.cm-line')!.firstChild!
  node.nodeValue = text
  window.getSelection()!.collapse(node, text.length)
}

it('a deferred IME flush is stored once', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(androidChrome126)
  vi.stubGlobal('EditContext', undefined)
  const nextFrame = controlFrames()
  const { view, draftStore, offer, events } = await mountEditor()

  fireEvent.compositionStart(view.contentDOM)
  act(() => replaceDOMText(view, 'lsにほん'))
  await act(async () => {})
  expect(view.composing).toBe(true)
  expect(view.state.doc.toString()).toBe('lsにほん')
  expect(draftStore.read('ime')).toBe('ls')
  expect(offer).not.toHaveBeenCalled()

  act(() => {
    replaceDOMText(view, 'ls日本')
    fireEvent.compositionEnd(view.contentDOM, { data: '日本' })
  })
  await act(async () => {})
  expect(view.state.doc.toString()).toBe('lsにほん')
  expect(draftStore.read('ime')).toBe('ls')
  expect(offer).not.toHaveBeenCalled()

  nextFrame()
  expect(events).toEqual(['lsにほん', 'ls日本'])
  expect(view.state.doc.toString()).toBe('ls日本')
  expect(draftStore.read('ime')).toBe('ls日本')
  expect(offer).toHaveBeenCalledExactlyOnceWith('ime', 'Editor', 'ls日本')
  act(() => view.dispatch({ changes: { from: 4, insert: '!' }, userEvent: 'input.type' }))
  expect(draftStore.read('ime')).toBe('ls日本!')
  expect(offer).toHaveBeenCalledTimes(2)
})

class TestEditContext extends EventTarget {
  text: string
  selectionStart: number
  selectionEnd: number

  constructor(init: { text: string; selectionStart: number; selectionEnd: number }) {
    super()
    this.text = init.text
    this.selectionStart = init.selectionStart
    this.selectionEnd = init.selectionEnd
  }

  updateText(from: number, to: number, text: string) {
    this.text = this.text.slice(0, from) + text + this.text.slice(to)
  }

  updateSelection(start: number, end: number) {
    this.selectionStart = start
    this.selectionEnd = end
  }

  updateControlBounds() {}
  updateSelectionBounds() {}
  updateCharacterBounds() {}

  textUpdate(from: number, to: number, text: string) {
    this.updateText(from, to, text)
    this.updateSelection(from + text.length, from + text.length)
    this.dispatchEvent(
      Object.assign(new Event('textupdate'), {
        updateRangeStart: from,
        updateRangeEnd: to,
        text,
        selectionStart: this.selectionStart,
        selectionEnd: this.selectionEnd
      })
    )
  }
}

it.each([
  'commit',
  'cancel',
  'missed compositionend'
])('an IME composition ending without a DOM event is stored (%s)', async (ending) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(androidChrome126)
  vi.stubGlobal('EditContext', TestEditContext)
  const nextFrame = controlFrames()
  const { view, draftStore, offer, events } = await mountEditor('ls ')
  const context = (view.contentDOM as HTMLElement & { editContext: TestEditContext }).editContext
  expect(context).toBeInstanceOf(TestEditContext)
  const domEnd = vi.fn()
  view.contentDOM.addEventListener('compositionend', domEnd)

  act(() => {
    context.dispatchEvent(new Event('compositionstart'))
    context.textUpdate(3, 3, 'にほん')
  })
  expect(view.composing).toBe(true)
  expect(view.state.doc.toString()).toBe('ls にほん')
  expect(draftStore.read('ime')).toBe('ls ')
  expect(offer).not.toHaveBeenCalled()

  const finalText = ending === 'commit' ? 'ls 日本' : 'ls '
  act(() => {
    context.textUpdate(3, 6, ending === 'commit' ? '日本' : '')
    if (ending !== 'missed compositionend') {
      context.dispatchEvent(new Event('compositionend'))
    }
  })
  await act(async () => {})
  if (ending !== 'missed compositionend') nextFrame()
  expect(domEnd).not.toHaveBeenCalled()
  expect(view.compositionStarted).toBe(false)
  expect(view.composing).toBe(false)
  expect(events).toEqual(['ls にほん', finalText])
  expect(view.state.doc.toString()).toBe(finalText)
  expect(draftStore.read('ime')).toBe(finalText)
  expect(offer).toHaveBeenCalledExactlyOnceWith('ime', 'Editor', finalText)

  act(() => context.textUpdate(context.text.length, context.text.length, '!'))
  expect(draftStore.read('ime')).toBe(`${finalText}!`)
  expect(offer).toHaveBeenCalledTimes(2)
})

it('a destroyed editor stores nothing late', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(androidChrome126)
  vi.stubGlobal('EditContext', undefined)
  const nextFrame = controlFrames()
  const draftStore = createCommandDraftStore()
  const { view, offer, unmount } = await mountEditor('ls', draftStore)

  fireEvent.compositionStart(view.contentDOM)
  act(() => replaceDOMText(view, 'lsにほん'))
  await act(async () => {})
  expect(draftStore.read('ime')).toBe('ls')

  act(() => {
    replaceDOMText(view, 'ls日本')
    fireEvent.compositionEnd(view.contentDOM, { data: '日本' })
  })
  await act(async () => {})
  expect(draftStore.read('ime')).toBe('ls')

  offer.mockClear()
  unmount()
  nextFrame()
  expect(offer).not.toHaveBeenCalled()
  expect(draftStore.read('ime')).toBe('ls')

  const remounted = await mountEditor('ls', draftStore, false)
  expect(remounted.view.state.doc.toString()).toBe('ls')
  expect(draftStore.read('ime')).toBe('ls')
})
