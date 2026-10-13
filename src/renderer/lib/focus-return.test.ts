import { afterEach, describe, expect, it } from 'vitest'
import { captureFocusReturnTarget } from './focus-return'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('captureFocusReturnTarget', () => {
  it('returns the focused element', () => {
    document.body.innerHTML = '<button id="b">b</button>'
    const button = document.getElementById('b') as HTMLButtonElement
    button.focus()
    expect(captureFocusReturnTarget()).toBe(button)
  })

  it('maps a menu item to its menu trigger', () => {
    document.body.innerHTML =
      '<button id="trigger">more</button><div role="menu" aria-labelledby="trigger"><div role="menuitem" tabindex="-1" id="item">Delete</div></div>'
    ;(document.getElementById('item') as HTMLElement).focus()
    expect(captureFocusReturnTarget()).toBe(document.getElementById('trigger'))
  })

  it('returns null when nothing is focused', () => {
    expect(captureFocusReturnTarget()).toBeNull()
  })
})
