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

  it('consumes the destination: the next close returns to the opener', () => {
    const opener = mount<HTMLButtonElement>('button')
    const destination = mount<HTMLHeadingElement>('h1')
    destination.tabIndex = -1
    recordSheetOpener('files-sheet', opener)
    setSheetFocusDestination('files-sheet', destination)
    const handler = sheetCloseAutoFocus('files-sheet')

    handler(closeEvent())
    expect(document.activeElement).toBe(destination)

    destination.blur()
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
    handler(closeEvent())
    expect(document.activeElement).toBe(opener)
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
})
