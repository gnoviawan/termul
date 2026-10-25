import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import type { ReactElement } from 'react'
import { bindCompatRenderer, nodeFor, type TrackedInstance } from '../../src/compat/dom-node'
import { jsx } from '../../src/compat/jsx-runtime'
import type { Bounds, CompatRenderer, TreeJson } from '../../src/compat/live-reads'
import { sentinelPress } from '../../src/compat/window-press'

type Native = Record<string, unknown> & { ref?: (instance: TrackedInstance | null) => unknown }
type Listener = (payload: EventPayload) => void

/** A page (300) holding a button (301) and a plain text block (302) with no listeners. */
const BOXES: Record<number, Bounds> = {
  300: { x: 0, y: 0, width: 800, height: 600 },
  301: { x: 10, y: 10, width: 100, height: 30 },
  302: { x: 10, y: 100, width: 300, height: 80 }
}
const TREE: TreeJson = {
  id: 300,
  type: 'div',
  bounds: BOXES[300],
  children: [
    { id: 301, type: 'div', bounds: BOXES[301] },
    { id: 302, type: 'div', bounds: BOXES[302] }
  ]
}

let focused: number | null = null
let blurs = 0
const focusState = (): { focused: number | null; blurs: number } => ({ focused, blurs })
const renderer: CompatRenderer = {
  focusElement() {},
  getFocusedElementId: () => focused,
  blur() {
    blurs++
    focused = null
  },
  scrollTo() {},
  scrollIntoView() {},
  getScrollOffset: () => null,
  getElementBounds: (id) => BOXES[id] ?? null,
  getAutomationTree: () => JSON.stringify(TREE)
}

const g = globalThis as { window?: EventTarget; document?: EventTarget }
let saved: { window?: EventTarget; document?: EventTarget }
let log: string[] = []
const listeners = new Map<number, Native>()

function mount(id: number, props: Record<string, unknown>): void {
  const element = jsx('div', props) as ReactElement<Native>
  const native = element.props
  native.ref?.({ id, type: 'div', props: native } as TrackedInstance)
  listeners.set(id, native)
}

function fire(id: number, name: string, payload: Partial<EventPayload>): void {
  const listener = listeners.get(id)?.[name] as Listener | undefined
  listener?.({ elementId: id, eventType: name, ...payload } as EventPayload)
}

function listen(host: EventTarget, label: string, types: string[]): void {
  for (const type of types) {
    host.addEventListener(type, (event) => {
      const target = event.target === nodeFor(301) ? 'button' : event.target === nodeFor(302) ? 'text' : 'other'
      log.push(`${label} ${type} ${target}`)
    })
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))
const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']

beforeEach(() => {
  log = []
  focused = null
  blurs = 0
  saved = { window: g.window, document: g.document }
  g.window = new EventTarget()
  g.document = new EventTarget()
  bindCompatRenderer(renderer)
  mount(300, {})
  mount(301, {
    onPointerDown: () => log.push('button pointerdown'),
    onMouseUp: () => log.push('button mouseup'),
    onClick: () => log.push('button click')
  })
  mount(302, {})
  listen(g.document, 'document', PRESS)
  listen(g.window, 'window', PRESS)
})

afterEach(() => {
  bindCompatRenderer(null)
  g.window = saved.window
  g.document = saved.document
})

describe('presses reach document and window', () => {
  test('a click on a listening button bubbles each event to document, then window, once', async () => {
    const at = { x: 50, y: 20, button: 0, clickCount: 1 }
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', ...at } as EventPayload)
    fire(301, 'onMouseDown', at)
    fire(301, 'onMouseDown', at)
    fire(301, 'onMouseUp', at)
    fire(301, 'onClick', at)
    await nextTask()
    expect(log).toEqual([
      'button pointerdown',
      'document pointerdown button',
      'window pointerdown button',
      'document mousedown button',
      'window mousedown button',
      'button mouseup',
      'document pointerup button',
      'window pointerup button',
      'document mouseup button',
      'window mouseup button',
      'button click',
      'document click button',
      'window click button'
    ])
  })

  test('a press on text no element listens to still reaches window, hit-tested to that text', async () => {
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', x: 40, y: 120, button: 0 } as EventPayload)
    expect(log).toEqual([])
    await nextTask()
    expect(log).toEqual([
      'document pointerdown text',
      'window pointerdown text',
      'document mousedown text',
      'window mousedown text'
    ])
  })

  test('a button that only listens for click gets the press before the click', async () => {
    mount(301, { onClick: () => log.push('button click') })
    const at = { x: 60, y: 25, button: 0, clickCount: 1 }
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', ...at } as EventPayload)
    fire(301, 'onClick', at)
    await nextTask()
    expect(log).toEqual([
      'document pointerdown button',
      'window pointerdown button',
      'document mousedown button',
      'window mousedown button',
      'button click',
      'document click button',
      'window click button'
    ])
  })

  test('stopPropagation on the element keeps the press from document and window', async () => {
    mount(301, {
      onPointerDown: (e: { stopPropagation(): void }) => {
        e.stopPropagation()
        log.push('button pointerdown stopped')
      }
    })
    const at = { x: 70, y: 30, button: 0, clickCount: 1 }
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', ...at } as EventPayload)
    fire(301, 'onMouseDown', at)
    await nextTask()
    expect(log).toEqual(['button pointerdown stopped'])
  })

  test('stopPropagation at document keeps that event from window', async () => {
    g.document?.addEventListener('mousedown', (e) => e.stopPropagation())
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', x: 40, y: 120, button: 0 } as EventPayload)
    await nextTask()
    expect(log).toEqual([
      'document pointerdown text',
      'window pointerdown text',
      'document mousedown text'
    ])
  })
})

describe('a press moves focus as the DOM default action does', () => {
  const press = (x: number, y: number) =>
    sentinelPress({ elementId: 1, eventType: 'mouseDownOutside', x, y, button: 0 } as EventPayload)

  test('a press on text that takes no focus blurs the focused field', async () => {
    focused = 301
    press(40, 120)
    await nextTask()
    expect(focusState()).toEqual({ focused: null, blurs: 1 })
  })

  test('a press inside the focused element keeps its focus', async () => {
    focused = 301
    press(50, 20)
    await nextTask()
    expect(focusState()).toEqual({ focused: 301, blurs: 0 })
  })

  test('preventDefault in an element mousedown handler keeps focus', async () => {
    focused = 301
    mount(302, { onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() })
    const at = { x: 40, y: 120, button: 0, clickCount: 1 }
    press(at.x, at.y)
    fire(302, 'onMouseDown', at)
    await nextTask()
    expect(focusState()).toEqual({ focused: 301, blurs: 0 })
  })

  test('preventDefault in a document mousedown listener keeps focus', async () => {
    focused = 301
    g.document?.addEventListener('mousedown', (e) => e.preventDefault())
    press(40, 120)
    await nextTask()
    expect(focusState()).toEqual({ focused: 301, blurs: 0 })
  })

  test('a press with nothing focused blurs nothing', async () => {
    press(40, 120)
    await nextTask()
    expect(blurs).toBe(0)
  })
})
