import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  _resetSheetFocusReturnForTests,
  recordSheetOpener,
  setSheetFocusDestination,
  sheetCloseAutoFocus
} from './sheet-focus-return'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function mount<T extends HTMLElement>(tag: string, parent: HTMLElement = document.body): T {
  const el = document.createElement(tag) as T
  if (tag === 'button') (el as unknown as HTMLButtonElement).type = 'button'
  parent.appendChild(el)
  return el
}

function closeEvent(): Event {
  return new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
}

describe('sheet focus return', () => {
  beforeEach(() => {
    vi.mocked(logFrontendError).mockClear()
    _resetSheetFocusReturnForTests()
    ;(document.activeElement as HTMLElement | null)?.blur()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('always prevents the Radix default close focus', () => {
    const handler = sheetCloseAutoFocus('files-sheet')

    const withTarget = closeEvent()
    recordSheetOpener('files-sheet', mount('button'))
    handler(withTarget)
    expect(withTarget.defaultPrevented).toBe(true)

    const withoutTarget = closeEvent()
    _resetSheetFocusReturnForTests()
    handler(withoutTarget)
    expect(withoutTarget.defaultPrevented).toBe(true)
  })

  it('focuses the recorded opener when focus was lost to body', () => {
    const opener = mount<HTMLButtonElement>('button')
    recordSheetOpener('files-sheet', opener)
    expect(document.activeElement).toBe(document.body)

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(opener)
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('prefers the destination over the opener', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(destination)
  })

  it('consumes the destination: the next open returns to its opener', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    const handler = sheetCloseAutoFocus('files-sheet')

    handler(closeEvent())
    expect(document.activeElement).toBe(destination)

    destination.blur()
    recordSheetOpener('files-sheet', opener)
    handler(closeEvent())
    expect(document.activeElement).toBe(opener)
  })

  it('consumes the destination even when focus had already moved elsewhere', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    const input = mount<HTMLInputElement>('input')
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    const handler = sheetCloseAutoFocus('files-sheet')

    input.focus()
    handler(closeEvent())
    expect(document.activeElement).toBe(input)

    input.blur()
    recordSheetOpener('files-sheet', opener)
    handler(closeEvent())
    expect(document.activeElement).toBe(opener)
  })

  it('consumes the opener and fallback: a later close with none recorded restores nothing', () => {
    const opener = mount<HTMLButtonElement>('button')
    const fallback = mount<HTMLButtonElement>('button')
    recordSheetOpener('git-sheet', opener, fallback)
    const handler = sheetCloseAutoFocus('git-sheet')

    handler(closeEvent())
    expect(document.activeElement).toBe(opener)
    expect(logFrontendError).not.toHaveBeenCalled()

    // The sheet is reopened by something that records no opener, so the earlier
    // opener (still connected) must not take focus.
    opener.blur()
    handler(closeEvent())
    expect(document.activeElement).toBe(document.body)
    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'info',
      source: 'sheet-focus-return',
      message: 'Sheet closed with no connected focus target: git-sheet'
    })
  })

  it('consumes the opener even when focus already sits elsewhere', () => {
    const opener = mount<HTMLButtonElement>('button')
    const input = mount<HTMLInputElement>('input')
    recordSheetOpener('git-sheet', opener)
    const handler = sheetCloseAutoFocus('git-sheet')

    input.focus()
    handler(closeEvent())
    expect(document.activeElement).toBe(input)

    input.blur()
    handler(closeEvent())
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus where it is when it already sits on a connected element other than body', () => {
    const opener = mount<HTMLButtonElement>('button')
    const input = mount<HTMLInputElement>('input')
    recordSheetOpener('file-actions-sheet', opener)
    input.focus()

    sheetCloseAutoFocus('file-actions-sheet')(closeEvent())

    expect(document.activeElement).toBe(input)
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('falls back to the opener when the destination is detached', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    destination.remove()

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(opener)
  })

  it('logs at info with the sheet id only when no target is connected', () => {
    const opener = mount<HTMLButtonElement>('button')
    recordSheetOpener('git-sheet', opener)
    opener.remove()

    sheetCloseAutoFocus('git-sheet')(closeEvent())

    expect(document.activeElement).toBe(document.body)
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'info',
      source: 'sheet-focus-return',
      message: 'Sheet closed with no connected focus target: git-sheet'
    })
  })

  it('logs at info when the connected opener refuses focus (disabled)', () => {
    const opener = mount<HTMLButtonElement>('button')
    recordSheetOpener('git-sheet', opener)
    opener.disabled = true

    sheetCloseAutoFocus('git-sheet')(closeEvent())

    expect(document.activeElement).toBe(document.body)
    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'info',
      source: 'sheet-focus-return',
      message: 'Sheet closed with no connected focus target: git-sheet'
    })
  })

  it('falls back to the opener when the connected destination refuses focus', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLButtonElement>('button')
    destination.disabled = true
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(opener)
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it('logs at info when nothing was ever recorded', () => {
    sheetCloseAutoFocus('git-sheet')(closeEvent())
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'sheet-focus-return' })
    )
  })

  it('keeps recordings separate per sheet id', () => {
    const filesOpener = mount<HTMLButtonElement>('button')
    const gitOpener = mount<HTMLButtonElement>('button')
    recordSheetOpener('files-sheet', filesOpener)
    recordSheetOpener('git-sheet', gitOpener)

    sheetCloseAutoFocus('git-sheet')(closeEvent())
    expect(document.activeElement).toBe(gitOpener)

    gitOpener.blur()
    sheetCloseAutoFocus('files-sheet')(closeEvent())
    expect(document.activeElement).toBe(filesOpener)
  })

  it('uses the most recent opener', () => {
    const first = mount<HTMLButtonElement>('button')
    const second = mount<HTMLButtonElement>('button')
    recordSheetOpener('file-actions-sheet', first)
    recordSheetOpener('file-actions-sheet', second)

    sheetCloseAutoFocus('file-actions-sheet')(closeEvent())

    expect(document.activeElement).toBe(second)
  })

  it('clears a destination when set to null', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    setSheetFocusDestination('files-sheet', null)

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(opener)
  })

  it('drops a stale destination when the next open records its opener', () => {
    // A file finished opening after the sheet was dismissed, so the destination
    // was set with no close left to consume it.
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    setSheetFocusDestination('files-sheet', destination)

    // The sheet is opened again from the opener and then dismissed.
    recordSheetOpener('files-sheet', opener)
    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(opener)
  })

  it('keeps a destination set after the opener was recorded for the same open', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    // Recording a different sheet's opener must not touch this sheet's destination.
    recordSheetOpener('git-sheet', mount('button'))

    sheetCloseAutoFocus('files-sheet')(closeEvent())

    expect(document.activeElement).toBe(destination)
  })

  it.each([
    ['xterm', 'xterm'],
    ['CodeMirror', 'cm-editor'],
    ['the composer editor', 'ProseMirror']
  ])('never focuses %s from a focus-return path', (_, className) => {
    const surface = mount<HTMLDivElement>('div')
    surface.className = className
    const editable = mount<HTMLTextAreaElement>('textarea', surface)
    const opener = mount<HTMLButtonElement>('button')

    // A destination inside the editor is skipped in favour of the opener.
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', editable)
    sheetCloseAutoFocus('files-sheet')(closeEvent())
    expect(document.activeElement).toBe(opener)

    // An opener inside the editor is never focused either.
    opener.blur()
    recordSheetOpener('git-sheet', editable)
    sheetCloseAutoFocus('git-sheet')(closeEvent())
    expect(document.activeElement).toBe(document.body)
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'sheet-focus-return' })
    )
  })

  describe('destination resolver', () => {
    it('evaluates the resolver when the sheet closes, not when it is set', () => {
      const opener = mount<HTMLButtonElement>('button')
      const late = mount<HTMLHeadingElement>('h1')
      late.tabIndex = -1
      const resolver = vi.fn<() => HTMLElement | null>(() => late)
      recordSheetOpener('mobile-drawer', opener)

      setSheetFocusDestination('mobile-drawer', resolver)
      expect(resolver).not.toHaveBeenCalled()

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(resolver).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(late)
    })

    it('sees an element that only exists once the sheet has closed', () => {
      const opener = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener)
      let target: HTMLButtonElement | null = null
      setSheetFocusDestination('mobile-drawer', () => target)

      // The destination is mounted after it was set, before the close.
      target = mount<HTMLButtonElement>('button')
      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(target)
    })

    it('consumes the resolver: the next open returns to its opener', () => {
      const opener = mount<HTMLButtonElement>('button')
      const destination = mount<HTMLHeadingElement>('h1')
      destination.tabIndex = -1
      const resolver = vi.fn(() => destination)
      recordSheetOpener('mobile-drawer', opener)
      setSheetFocusDestination('mobile-drawer', resolver)
      const handler = sheetCloseAutoFocus('mobile-drawer')

      handler(closeEvent())
      destination.blur()
      recordSheetOpener('mobile-drawer', opener)
      handler(closeEvent())

      expect(resolver).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(opener)
    })

    it('does not evaluate the resolver when focus already sits elsewhere, and still consumes it', () => {
      const opener = mount<HTMLButtonElement>('button')
      const input = mount<HTMLInputElement>('input')
      const resolver = vi.fn(() => opener)
      recordSheetOpener('mobile-drawer', opener)
      setSheetFocusDestination('mobile-drawer', resolver)
      const handler = sheetCloseAutoFocus('mobile-drawer')

      input.focus()
      handler(closeEvent())
      expect(resolver).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input)

      input.blur()
      recordSheetOpener('mobile-drawer', opener)
      handler(closeEvent())
      expect(resolver).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(opener)
    })

    it('falls through to the opener when the resolver returns null', () => {
      const opener = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener)
      setSheetFocusDestination('mobile-drawer', () => null)

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(opener)
      expect(logFrontendError).not.toHaveBeenCalled()
    })

    it('treats a throwing resolver as no destination: logs the sheet id and still tries the opener', () => {
      const opener = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener)
      setSheetFocusDestination('mobile-drawer', () => {
        throw new Error('secret element text')
      })

      expect(() => sheetCloseAutoFocus('mobile-drawer')(closeEvent())).not.toThrow()

      expect(document.activeElement).toBe(opener)
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith({
        level: 'error',
        source: 'sheet-focus-return',
        message: 'Sheet focus destination resolver threw: mobile-drawer'
      })
    })

    it('tries the fallback after a throwing resolver and a gone opener', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      opener.remove()
      setSheetFocusDestination('mobile-drawer', () => {
        throw new Error('boom')
      })

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(fallback)
    })

    it('skips an element inside an editor surface returned by the resolver', () => {
      const surface = mount<HTMLDivElement>('div')
      surface.className = 'ProseMirror'
      const editable = mount<HTMLTextAreaElement>('textarea', surface)
      const opener = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener)
      setSheetFocusDestination('mobile-drawer', () => editable)

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(opener)
    })
  })

  describe('fallback', () => {
    it('is tried after the opener is gone', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      opener.remove()

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(fallback)
      expect(logFrontendError).not.toHaveBeenCalled()
    })

    it('is tried after the opener refuses focus', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      opener.disabled = true

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(fallback)
    })

    it('is not used while the opener can take focus', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(opener)
    })

    it('is tried after a destination that resolves to nothing', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      opener.remove()
      setSheetFocusDestination('mobile-drawer', () => null)

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(fallback)
    })

    it('logs at info when the opener and the fallback are both gone', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      opener.remove()
      fallback.remove()

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(document.body)
      expect(logFrontendError).toHaveBeenCalledWith({
        level: 'info',
        source: 'sheet-focus-return',
        message: 'Sheet closed with no connected focus target: mobile-drawer'
      })
    })

    it('is replaced on every record: a record without one clears the old fallback', () => {
      const first = mount<HTMLButtonElement>('button')
      const second = mount<HTMLButtonElement>('button')
      const stale = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', first, stale)
      recordSheetOpener('mobile-drawer', second)
      second.remove()

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(document.body)
      expect(logFrontendError).toHaveBeenCalledTimes(1)
    })

    it('belongs to its sheet id', () => {
      const opener = mount<HTMLButtonElement>('button')
      const fallback = mount<HTMLButtonElement>('button')
      const other = mount<HTMLButtonElement>('button')
      recordSheetOpener('mobile-drawer', opener, fallback)
      recordSheetOpener('git-sheet', other)
      opener.remove()

      sheetCloseAutoFocus('mobile-drawer')(closeEvent())

      expect(document.activeElement).toBe(fallback)
      expect(document.activeElement).not.toBe(other)
    })
  })

  it('drops a stale resolver and fallback when the next open records its opener', () => {
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    const staleFallback = mount<HTMLButtonElement>('button')
    const resolver = vi.fn(() => destination)
    recordSheetOpener('mobile-drawer', mount('button'), staleFallback)
    setSheetFocusDestination('mobile-drawer', resolver)

    // The drawer is opened again from another control and then dismissed.
    const opener = mount<HTMLButtonElement>('button')
    recordSheetOpener('mobile-drawer', opener)
    sheetCloseAutoFocus('mobile-drawer')(closeEvent())
    expect(resolver).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)

    // With the opener gone, the stale fallback is not resurrected.
    opener.blur()
    opener.remove()
    sheetCloseAutoFocus('mobile-drawer')(closeEvent())
    expect(document.activeElement).toBe(document.body)
  })
})
