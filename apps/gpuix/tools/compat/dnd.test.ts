import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import type { ReactElement } from 'react'
import { setDroppedFileOpener } from '../../src/compat/dnd'
import { bindCompatRenderer, type TrackedInstance } from '../../src/compat/dom-node'
import { jsx } from '../../src/compat/jsx-runtime'
import type { Bounds, CompatRenderer, TreeJson } from '../../src/compat/live-reads'
import { translation } from '../../src/compat/translate'

type Native = Record<string, unknown> & { ref?: (instance: TrackedInstance | null) => unknown }
type Listener = (payload: EventPayload) => void

/**
 * A tab bar (id 101) holding tabs A (102) and B (103), a pane (104) whose
 * right-edge drop zone (105) is painted over it, and a `pointer-events: none`
 * overlay (106) painted over everything, as the root's portal layer is.
 */
const BOXES: Record<number, Bounds> = {
  100: { x: 0, y: 0, width: 800, height: 600 },
  101: { x: 0, y: 0, width: 800, height: 40 },
  102: { x: 0, y: 0, width: 100, height: 40 },
  103: { x: 100, y: 0, width: 100, height: 40 },
  104: { x: 0, y: 40, width: 800, height: 560 },
  105: { x: 600, y: 40, width: 200, height: 560 },
  106: { x: 0, y: 0, width: 800, height: 600 }
}
const node = (id: number, children?: TreeJson[]): TreeJson => ({
  id,
  type: 'div',
  bounds: BOXES[id],
  children
})
const TREE = node(100, [node(101, [node(102), node(103)]), node(104, [node(105)]), node(106)])

const renderer: CompatRenderer = {
  focusElement() {},
  getFocusedElementId: () => null,
  blur() {},
  scrollTo() {},
  scrollIntoView() {},
  getScrollOffset: () => null,
  getElementBounds: (id) => BOXES[id] ?? null,
  getAutomationTree: () => JSON.stringify(TREE)
}

let log: string[] = []
const listeners = new Map<number, Native>()

/** Create the compat element, then mount it as GPUIX would: the ref gets the instance. */
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

beforeEach(() => {
  log = []
  bindCompatRenderer(renderer)
  const tab = (name: string) => ({
    draggable: true,
    onClick: () => log.push(`click ${name}`),
    onDragStart: (e: { dataTransfer: DataTransfer }) => {
      e.dataTransfer.setData('application/json', JSON.stringify({ tab: name }))
      e.dataTransfer.effectAllowed = 'move'
      log.push(`dragstart ${name}`)
    },
    onDragOver: (e: { preventDefault(): void; clientX: number }) => {
      e.preventDefault()
      log.push(`dragover ${name} x=${e.clientX}`)
    },
    onDrop: (e: { dataTransfer: DataTransfer; stopPropagation(): void }) => {
      e.stopPropagation()
      log.push(`drop on ${name} data=${e.dataTransfer.getData('application/json')}`)
    },
    onDragEnd: () => log.push(`dragend ${name}`)
  })
  mount(100, {})
  mount(101, {
    onDragLeave: (e: { relatedTarget: unknown }) =>
      log.push(`bar dragleave related=${e.relatedTarget !== null}`)
  })
  mount(102, tab('A'))
  mount(103, tab('B'))
  mount(104, {})
  mount(106, { className: 'absolute inset-0 pointer-events-none' })
  mount(105, {
    onDragEnter: () => log.push('zone dragenter'),
    onDragOver: (e: { preventDefault(): void; dataTransfer: DataTransfer }) => {
      e.preventDefault()
      log.push(
        `zone dragover types=${e.dataTransfer.types.join(',')} data=${e.dataTransfer.getData('application/json') || '(protected)'}`
      )
    },
    onDrop: (e: { dataTransfer: DataTransfer }) => {
      const files = [...e.dataTransfer.files].map((f) => `${f.name}:${f.size}`)
      log.push(
        `zone drop data=${e.dataTransfer.getData('application/json')} files=${files.join(',')}`
      )
    }
  })
})

afterEach(() => {
  bindCompatRenderer(null)
  setDroppedFileOpener(null)
})

describe('html5 drag and drop', () => {
  test('a draggable tab gets every listener GPUIX needs to capture the pointer', () => {
    const native = listeners.get(102)!
    expect([typeof native.onMouseDown, typeof native.onMouseMove, typeof native.onMouseUp]).toEqual(
      ['function', 'function', 'function']
    )
  })

  test('dragging tab B onto the left half of tab A runs the DOM sequence and drops there', () => {
    fire(103, 'onMouseDown', { x: 150, y: 20, button: 0 })
    fire(103, 'onMouseMove', { x: 152, y: 20, pressedButton: 0 })
    expect(log).toEqual([])
    fire(103, 'onMouseMove', { x: 130, y: 20, pressedButton: 0 })
    fire(103, 'onMouseMove', { x: 30, y: 20, pressedButton: 0 })
    fire(103, 'onMouseUp', { x: 30, y: 20, button: 0 })
    fire(103, 'onClick', { x: 30, y: 20, button: 0, clickCount: 1 })
    expect(log).toEqual([
      'dragstart B',
      'dragover B x=150',
      'dragover B x=130',
      'bar dragleave related=true',
      'dragover A x=30',
      'dragover A x=30',
      'drop on A data={"tab":"B"}',
      'dragend B'
    ])
  })

  test('the pane zone reads protected data while hovering and the payload on drop; the bar sees the leave', () => {
    fire(102, 'onMouseDown', { x: 50, y: 20, button: 0 })
    fire(102, 'onMouseMove', { x: 700, y: 300, pressedButton: 0 })
    fire(102, 'onMouseUp', { x: 700, y: 300, button: 0 })
    expect(log).toEqual([
      'dragstart A',
      'dragover A x=50',
      'zone dragenter',
      'bar dragleave related=true',
      'zone dragover types=application/json data=(protected)',
      'zone dragover types=application/json data=(protected)',
      'zone drop data={"tab":"A"} files=',
      'dragend A'
    ])
  })

  test('a press released without moving is a click, not a drag', () => {
    fire(102, 'onMouseDown', { x: 50, y: 20, button: 0 })
    fire(102, 'onMouseUp', { x: 50, y: 20, button: 0 })
    fire(102, 'onClick', { x: 50, y: 20, button: 0, clickCount: 1 })
    expect(log).toEqual(['click A'])
  })

  test('an OS file drop on the zone delivers the dropped paths as Files', () => {
    setDroppedFileOpener(
      (path) => new File(['x'.repeat(5)], path.split('/').pop()!, { type: 'text/plain' })
    )
    fire(105, 'onFileDrop', { x: 650, y: 100, paths: ['/tmp/notes.txt'] })
    expect(log).toEqual([
      'zone dragenter',
      'zone dragover types=Files data=(protected)',
      'zone drop data= files=notes.txt:5'
    ])
  })

  test('a drop zone placed with left-1/4 keeps its percent offset instead of losing it', () => {
    const zone = jsx('div', {
      className: 'absolute left-1/4 top-1/4 w-1/2 h-1/2',
      onDrop: () => {}
    }) as ReactElement<{
      style: unknown
      children: ReactElement<{
        style: unknown
        children: (ReactElement<{ style: unknown }> | null)[]
      }>[]
    }>
    const [top, row, bottom] = zone.props.children
    const [left, element, right] = row.props.children
    expect(translation('div', 'absolute left-1/4 top-1/4 w-1/2 h-1/2').base as unknown).toEqual({
      position: 'absolute',
      width: '50%',
      height: '50%',
      left: '25%',
      top: '25%'
    })
    expect([top.props.style, bottom, row.props.style, left?.props.style, right]).toEqual([
      { height: '25%', flexShrink: 0, pointerEvents: 'none' },
      null,
      {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'flex-start',
        flexShrink: 0,
        pointerEvents: 'none',
        height: '50%'
      },
      { width: '25%', flexShrink: 0, pointerEvents: 'none' },
      null
    ])
    expect(element?.props.style).toEqual({
      width: '50%',
      height: '100%',
      position: 'relative',
      flexShrink: 0
    })
  })
})
