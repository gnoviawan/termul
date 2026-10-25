import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import type { ReactElement } from 'react'
import { bindCompatRenderer, type TrackedInstance } from '../../src/compat/dom-node'
import { jsx } from '../../src/compat/jsx-runtime'
import type { CompatRenderer } from '../../src/compat/live-reads'

type Native = Record<string, unknown> & { ref?: (instance: TrackedInstance | null) => unknown }

const renderer: CompatRenderer = {
  focusElement() {},
  getFocusedElementId: () => null,
  blur() {},
  scrollTo() {},
  scrollIntoView() {},
  getScrollOffset: () => null,
  getElementBounds: () => ({ x: 0, y: 0, width: 100, height: 40 }),
  getAutomationTree: () => JSON.stringify({ id: 1, type: 'div' })
}

const g = globalThis as { window?: EventTarget }
const hadWindow = 'window' in g
const originalWindow = g.window
let presses: Array<{ target: unknown; clientX: number }> = []
let native: Native

function fire(name: string, payload: Partial<EventPayload>): void {
  const listener = native[name] as ((payload: EventPayload) => void) | undefined
  listener?.({ elementId: 1, eventType: name, ...payload } as EventPayload)
}

beforeEach(async () => {
  // Presses less than 150 ms apart are one action; start each test past the last one.
  await Bun.sleep(160)
  bindCompatRenderer(renderer)
  g.window = new EventTarget()
  presses = []
  g.window.addEventListener('pointerdown', (e) =>
    presses.push({
      target: (e as Event & { target: unknown }).target,
      clientX: (e as MouseEvent).clientX
    })
  )
  const element = jsx('div', { onClick: () => {}, onMouseDown: () => {} }) as ReactElement<Native>
  native = element.props
  native.ref?.({ id: 1, type: 'div', props: native } as TrackedInstance)
})

afterEach(() => {
  if (hadWindow) g.window = originalWindow
  else delete g.window
})

test('a click on an element reaches window as one pointerdown at its target', () => {
  fire('onClick', { x: 12, y: 8, clickCount: 1 })

  expect(presses).toHaveLength(1)
  expect(presses[0].clientX).toBe(12)
  expect(presses[0].target).not.toBeNull()
})

test('a press and the click GPUIX reports after it announce once', () => {
  fire('onMouseDown', { x: 12, y: 8, button: 0 })
  fire('onClick', { x: 12, y: 8, clickCount: 1 })

  expect(presses).toHaveLength(1)
})

test('two separate presses announce twice', async () => {
  fire('onClick', { x: 12, y: 8, clickCount: 1 })
  await Bun.sleep(160)
  fire('onClick', { x: 30, y: 8, clickCount: 1 })

  expect(presses.map((p) => p.clientX)).toEqual([12, 30])
})
