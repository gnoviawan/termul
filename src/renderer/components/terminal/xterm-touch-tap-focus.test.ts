import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindXtermTouchTapFocus } from './xterm-touch-tap-focus'

interface Harness {
  element: HTMLDivElement
  textarea: HTMLTextAreaElement
  focus: ReturnType<typeof vi.fn>
  terminal: Terminal
}

function createHarness(): Harness {
  const element = document.createElement('div')
  element.className = 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  element.appendChild(textarea)
  document.body.appendChild(element)

  const focus = vi.fn(() => {
    textarea.focus()
  })
  const terminal = { element, focus } as unknown as Terminal
  return { element, textarea, focus, terminal }
}

function dispatchTouch(
  target: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  points: Array<{ x: number; y: number }>
): Event {
  const touches = points.map((point, index) => ({
    clientX: point.x,
    clientY: point.y,
    identifier: index
  }))
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : touches
  })
  Object.defineProperty(event, 'changedTouches', { value: touches })
  target.dispatchEvent(event)
  return event
}

describe('bindXtermTouchTapFocus', () => {
  const attached: HTMLElement[] = []
  let now = 0

  afterEach(() => {
    vi.restoreAllMocks()
    for (const node of attached) node.remove()
    attached.length = 0
    now = 0
  })

  function mount(): Harness {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const harness = createHarness()
    attached.push(harness.element)
    bindXtermTouchTapFocus(harness.terminal)
    return harness
  }

  function tap(element: HTMLElement, from: { x: number; y: number }, to = from): void {
    dispatchTouch(element, 'touchstart', [from])
    if (to.x !== from.x || to.y !== from.y) {
      dispatchTouch(element, 'touchmove', [to])
    }
    dispatchTouch(element, 'touchend', [to])
  }

  it('focuses the helper textarea on a tap when focus is elsewhere', () => {
    const { element, focus } = mount()
    const start = dispatchTouch(element, 'touchstart', [{ x: 20, y: 20 }])
    const end = dispatchTouch(element, 'touchend', [{ x: 24, y: 22 }])

    expect(focus).toHaveBeenCalledOnce()
    expect(start.defaultPrevented).toBe(false)
    expect(end.defaultPrevented).toBe(false)
  })

  it('does not focus again when the terminal already holds focus', () => {
    const { element, textarea, focus } = mount()
    textarea.focus()
    tap(element, { x: 20, y: 20 })
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not focus on a drag past the xterm tap slop (scroll or selection)', () => {
    const { element, focus } = mount()
    tap(element, { x: 10, y: 10 }, { x: 10, y: 48 })
    expect(focus).not.toHaveBeenCalled()
  })

  it('still focuses a sloppy tap inside the 30px slop', () => {
    const { element, focus } = mount()
    tap(element, { x: 10, y: 10 }, { x: 10, y: 39 })
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does not focus a stationary long-press', () => {
    const { element, focus } = mount()
    now = 1_000
    dispatchTouch(element, 'touchstart', [{ x: 8, y: 8 }])
    now = 1_700
    dispatchTouch(element, 'touchend', [{ x: 8, y: 8 }])
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not focus after a second finger lands or the touch is cancelled', () => {
    const { element, focus } = mount()
    dispatchTouch(element, 'touchstart', [{ x: 4, y: 4 }])
    dispatchTouch(element, 'touchmove', [
      { x: 4, y: 4 },
      { x: 6, y: 6 }
    ])
    dispatchTouch(element, 'touchend', [{ x: 4, y: 4 }])

    dispatchTouch(element, 'touchstart', [{ x: 4, y: 4 }])
    dispatchTouch(element, 'touchcancel', [{ x: 4, y: 4 }])
    dispatchTouch(element, 'touchend', [{ x: 4, y: 4 }])

    expect(focus).not.toHaveBeenCalled()
  })

  it('ignores mouse clicks', () => {
    const { element, focus } = mount()
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(focus).not.toHaveBeenCalled()
  })

  it('binds once per element and still binds a second terminal', () => {
    const first = mount()
    bindXtermTouchTapFocus(first.terminal)
    tap(first.element, { x: 1, y: 1 })
    expect(first.focus).toHaveBeenCalledOnce()

    const second = mount()
    tap(second.element, { x: 3, y: 3 })
    expect(second.focus).toHaveBeenCalledOnce()
  })
})
