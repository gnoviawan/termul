import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSheetCloseFocus } from './use-sheet-close-focus'

describe('useSheetCloseFocus', () => {
  let opener: HTMLButtonElement
  let title: HTMLHeadingElement
  let other: HTMLButtonElement

  beforeEach(() => {
    opener = document.createElement('button')
    title = document.createElement('h1')
    title.tabIndex = -1
    other = document.createElement('button')
    document.body.append(opener, title, other)
  })

  afterEach(() => {
    opener.remove()
    title.remove()
    other.remove()
  })

  function setup(withTitle = true) {
    return renderHook(() =>
      useSheetCloseFocus({ current: opener }, withTitle ? { current: title } : undefined)
    ).result.current
  }

  it('focuses the opener after a plain dismissal and prevents the Radix default', () => {
    const { onCloseAutoFocus } = setup()
    const event = new Event('focusout', { cancelable: true })

    onCloseAutoFocus(event)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('focuses the title after a row was chosen, then forgets the choice', () => {
    const { markItemChosen, onCloseAutoFocus } = setup()

    markItemChosen()
    onCloseAutoFocus(new Event('focusout', { cancelable: true }))
    expect(document.activeElement).toBe(title)

    ;(document.activeElement as HTMLElement).blur()
    onCloseAutoFocus(new Event('focusout', { cancelable: true }))
    expect(document.activeElement).toBe(opener)
  })

  it('leaves focus alone when another surface already took it', () => {
    const { markItemChosen, onCloseAutoFocus } = setup()
    other.focus()

    markItemChosen()
    onCloseAutoFocus(new Event('focusout', { cancelable: true }))

    expect(document.activeElement).toBe(other)
  })

  it('returns to the opener when the sheet has no title target', () => {
    const { markItemChosen, onCloseAutoFocus } = setup(false)

    markItemChosen()
    onCloseAutoFocus(new Event('focusout', { cancelable: true }))

    expect(document.activeElement).toBe(opener)
  })
})
