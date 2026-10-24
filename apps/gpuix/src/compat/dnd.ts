/**
 * HTML5 drag and drop on GPUIX, which has mouse capture and OS file drop but
 * no drag events. A press on a `draggable` element that moves 4px becomes
 * the DOM sequence shared code listens for: `dragstart` on the source, then
 * per move `drag`, `dragenter`/`dragleave` when the element under the pointer
 * changes and `dragover` on it, and on release `drop` (if the last
 * `dragover` was cancelled) and `dragend`. Every event bubbles through the
 * element's ancestors, then `document` and `window`, as in a page.
 *
 * The source carries mouse down, move and up, so GPUIX captures the pointer
 * for the whole gesture. The element under the pointer comes from
 * `getElementsAt`, the last painted frame's hit test.
 *
 * An OS file drop (`onFileDrop`) runs `dragenter`, `dragover` and `drop` at
 * the drop point with `Files` in `types` and the dropped paths as `File`s.
 */

import type { EventPayload } from '@gpuix/react'
import { ancestorIds, compatReads, nodeOrNull, trackedInstance, treeIndex } from './dom-node'
import { CompatEvent, type DomHandlers, domEvent, handlersOf } from './events'
import type { Bounds, TreeJson } from './live-reads'
import { compatWarn } from './log'

type DragType = 'dragstart' | 'drag' | 'dragend' | 'dragenter' | 'dragover' | 'dragleave' | 'drop'

const HANDLER: Readonly<Record<DragType, keyof DomHandlers>> = {
  dragstart: 'onDragStart',
  drag: 'onDrag',
  dragend: 'onDragEnd',
  dragenter: 'onDragEnter',
  dragover: 'onDragOver',
  dragleave: 'onDragLeave',
  drop: 'onDrop'
}

/** Pixels a press must travel before it becomes a drag. */
const DRAG_THRESHOLD = 4
/** GPUIX delivers a release's click after the drag ended; the DOM fires none. */
const CLICK_AFTER_DRAG_MS = 150

/** The DOM drag data store modes: written in dragstart, unreadable while hovering, read on drop. */
type DataMode = 'read-write' | 'protected' | 'read-only'

interface DataItem {
  readonly kind: 'string' | 'file'
  readonly type: string
  getAsFile(): File | null
  getAsString(callback: (value: string) => void): void
}

export class CompatDataTransfer {
  dropEffect: 'none' | 'copy' | 'link' | 'move' = 'none'
  effectAllowed = 'uninitialized'
  mode: DataMode = 'read-write'
  private readonly data = new Map<string, string>()

  constructor(private readonly dropped: readonly File[] = []) {}

  get types(): string[] {
    const types = [...this.data.keys()]
    if (this.dropped.length > 0) types.push('Files')
    return types
  }

  get files(): File[] {
    return this.mode === 'protected' ? [] : [...this.dropped]
  }

  get items(): DataItem[] {
    const strings = [...this.data.entries()].map(([type, value]) => ({
      kind: 'string' as const,
      type,
      getAsFile: () => null,
      getAsString: (callback: (value: string) => void) => callback(value)
    }))
    const files = this.files.map((file) => ({
      kind: 'file' as const,
      type: file.type,
      getAsFile: () => file,
      getAsString: () => {}
    }))
    return [...strings, ...files]
  }

  setData(type: string, value: string): void {
    if (this.mode === 'read-write') this.data.set(type.toLowerCase(), value)
  }

  getData(type: string): string {
    if (this.mode === 'protected') return ''
    return this.data.get(type.toLowerCase()) ?? ''
  }

  clearData(type?: string): void {
    if (this.mode !== 'read-write') return
    if (type === undefined) this.data.clear()
    else this.data.delete(type.toLowerCase())
  }

  setDragImage(): void {}
}

interface Point {
  x: number
  y: number
}

type Session =
  | { phase: 'pressed'; source: number; origin: Point; at: number }
  | {
      phase: 'dragging'
      source: number
      data: CompatDataTransfer
      /** The element under the pointer that last got dragenter/dragover. */
      over: number | null
      /** Whether that element cancelled its last dragover, which makes a release a drop. */
      accepted: boolean
      /** Pointer offset inside the source when the drag began, for the preview. */
      grab: Point
    }

let session: Session | null = null
/** Where and when the last drag was released. */
let lastRelease: (Point & { at: number }) | null = null

/** What a drag paints under the pointer: the source's box, translucent. */
export interface DragPreview {
  x: number
  y: number
  width: number
  height: number
}

let preview: DragPreview | null = null
const previewListeners = new Set<() => void>()

export function subscribeDragPreview(listener: () => void): () => void {
  previewListeners.add(listener)
  return () => previewListeners.delete(listener)
}

export function dragPreview(): DragPreview | null {
  return preview
}

function setPreview(next: DragPreview | null): void {
  preview = next
  for (const listener of previewListeners) listener()
}

/** Whether a click GPUIX is delivering belongs to the release of a drag. */
export function dragSuppressesClick(payload: EventPayload): boolean {
  if (session?.phase === 'dragging') return true
  const r = lastRelease
  return (
    r !== null &&
    r.x === payload.x &&
    r.y === payload.y &&
    performance.now() - r.at < CLICK_AFTER_DRAG_MS
  )
}

type FileOpener = (path: string) => File
let openFile: FileOpener | null = null

/** The environment seam supplies `File`s for dropped paths (`src/env/dom.ts`). */
export function setDroppedFileOpener(opener: FileOpener | null): void {
  openFile = opener
}

/**
 * Boxes compat adds around an element (placement wrappers, overlay layers):
 * never a drop target themselves, and their children decide for themselves.
 */
const transparent = new Set<number>()

export function hitTransparent(instance: { id: number } | null): (() => void) | undefined {
  if (!instance) return undefined
  const id = instance.id
  transparent.add(id)
  return () => {
    transparent.delete(id)
  }
}

function inside(b: Bounds, p: Point): boolean {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

/**
 * The DOM's hit test over the last painted tree: the last-painted, deepest
 * element whose box holds the point, inside every ancestor's box, skipping
 * `pointer-events: none` as CSS inherits it. GPUIX's own `getElementsAt`
 * cannot answer this: compat's click-through boxes carry `pointer-events:
 * none`, which hides their whole subtree from it.
 */
function deepest(node: TreeJson, p: Point, inheritedNone: boolean): number | null {
  if (node.bounds && !inside(node.bounds, p)) return null
  const own = trackedInstance(node.id)?.props.__dom?.pointerEvents
  const none = own === undefined ? inheritedNone : own === 'none'
  const kids = node.children ?? []
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i]
    const hit = kid ? deepest(kid, p, none) : null
    if (hit !== null) return hit
  }
  if (!node.bounds || none || transparent.has(node.id)) return null
  return node.id
}

function hitTest(point: Point): number | null {
  const tree = treeIndex().tree
  return tree ? deepest(tree, point, false) : null
}

function pointOf(payload: EventPayload): Point {
  return { x: payload.x ?? 0, y: payload.y ?? 0 }
}

type DragEventView = CompatEvent & { dataTransfer: CompatDataTransfer }

/** Fire one drag event at `target` and bubble it up, then to document and window. */
function dispatch(
  type: DragType,
  target: number,
  data: CompatDataTransfer,
  payload: EventPayload,
  related: number | null = null
): DragEventView {
  const event = new CompatEvent(
    type,
    nodeOrNull(target),
    payload,
    nodeOrNull(related)
  ) as DragEventView
  Object.defineProperty(event, 'dataTransfer', { value: data })
  const name = HANDLER[type]
  for (const at of [target, ...ancestorIds(target)]) {
    const handler = handlersOf(at)?.[name]
    if (!handler) continue
    event.currentTarget = nodeOrNull(at)
    handler(event)
    if (event.propagationStopped) return event
  }
  const g = globalThis as { document?: EventTarget; window?: EventTarget }
  for (const host of [g.document, g.window]) {
    if (!host || event.propagationStopped) continue
    const page = domEvent(
      type,
      {
        dataTransfer: data,
        target: event.target,
        relatedTarget: event.relatedTarget,
        clientX: event.clientX,
        clientY: event.clientY
      },
      () => event.preventDefault()
    )
    if (event.defaultPrevented) page.preventDefault()
    host.dispatchEvent(page)
    if (page.cancelBubble) event.stopPropagation()
  }
  return event
}

/** Move the drag to `point`: enter/leave on a change of element, then dragover. */
function hover(
  s: Extract<Session, { phase: 'dragging' }>,
  point: Point,
  payload: EventPayload
): void {
  const target = hitTest(point)
  if (target !== s.over) {
    const previous = s.over
    if (target !== null) dispatch('dragenter', target, s.data, payload, previous)
    if (previous !== null) dispatch('dragleave', previous, s.data, payload, target)
    s.over = target
  }
  s.accepted = target !== null && dispatch('dragover', target, s.data, payload).defaultPrevented
}

function begin(source: number, origin: Point, payload: EventPayload): void {
  const data = new CompatDataTransfer()
  const start = dispatch('dragstart', source, data, { ...payload, ...origin })
  if (start.defaultPrevented) {
    session = null
    return
  }
  data.mode = 'protected'
  const box = compatReads()?.bounds(source) ?? null
  const grab = box ? { x: origin.x - box.x, y: origin.y - box.y } : { x: 0, y: 0 }
  const s: Session = { phase: 'dragging', source, data, over: null, accepted: false, grab }
  session = s
  if (box) setPreview({ x: box.x, y: box.y, width: box.width, height: box.height })
  hover(s, origin, { ...payload, ...origin })
}

function finish(payload: EventPayload): void {
  const s = session
  session = null
  if (s?.phase !== 'dragging') return
  hover(s, pointOf(payload), payload)
  if (s.over !== null && s.accepted) {
    s.data.mode = 'read-only'
    dispatch('drop', s.over, s.data, payload)
  } else {
    if (s.over !== null) dispatch('dragleave', s.over, s.data, payload)
    s.data.dropEffect = 'none'
  }
  s.data.mode = 'protected'
  dispatch('dragend', s.source, s.data, payload)
  lastRelease = { ...pointOf(payload), at: performance.now() }
  setPreview(null)
}

/** Mouse down on a draggable element. The deepest draggable under the press wins. */
export function pressSource(payload: EventPayload): void {
  if ((payload.button ?? 0) !== 0) return
  if (session?.phase === 'dragging') return
  const now = performance.now()
  const s = session
  if (
    s?.phase === 'pressed' &&
    now - s.at < 100 &&
    ancestorIds(s.source).includes(payload.elementId)
  )
    return
  session = { phase: 'pressed', source: payload.elementId, origin: pointOf(payload), at: now }
}

/** Mouse move delivered to a draggable element (captured while pressed). */
export function moveSource(payload: EventPayload): void {
  const s = session
  if (!s || s.source !== payload.elementId) return
  if (payload.pressedButton === undefined) {
    if (s.phase === 'dragging') finish(payload)
    else session = null
    return
  }
  const point = pointOf(payload)
  if (s.phase === 'pressed') {
    if (Math.hypot(point.x - s.origin.x, point.y - s.origin.y) < DRAG_THRESHOLD) return
    begin(s.source, s.origin, payload)
    if (session?.phase !== 'dragging') return
  }
  const current = session as Extract<Session, { phase: 'dragging' }>
  dispatch('drag', current.source, current.data, payload)
  hover(current, point, payload)
  if (preview) setPreview({ ...preview, x: point.x - current.grab.x, y: point.y - current.grab.y })
}

/**
 * Mouse up on a draggable element, or anywhere once its drag lost the capture.
 *
 * A press that never became a drag is a click. GPUIX's pointer capture on the
 * source keeps that click from reaching the source's descendants (a chat
 * card's button inside its draggable row), so when the release lands on a
 * descendant this returns that element for the caller to click, and the click
 * GPUIX may still deliver to the source itself is dropped as a duplicate.
 */
export function releaseSource(payload: EventPayload): number | null {
  const s = session
  if (!s) return null
  if (s.phase === 'dragging') {
    finish(payload)
    return null
  }
  session = null
  const point = pointOf(payload)
  const target = hitTest(point)
  if (target === null || target === s.source || !ancestorIds(target).includes(s.source)) return null
  lastRelease = { ...point, at: performance.now() }
  return target
}

let lastFileDrop = ''

/** An OS file drop GPUIX delivered to an element that takes drops. */
export function fileDrop(payload: EventPayload): void {
  const paths = payload.paths ?? []
  const point = pointOf(payload)
  const key = `${point.x}:${point.y}:${paths.join('\n')}`
  if (paths.length === 0 || key === lastFileDrop) return
  lastFileDrop = key
  setTimeout(() => {
    if (lastFileDrop === key) lastFileDrop = ''
  }, 100)
  if (!openFile) {
    compatWarn('dnd-file-drop', 'no file opener installed')
    return
  }
  const data = new CompatDataTransfer(paths.map((path) => openFile!(path)))
  data.mode = 'protected'
  data.effectAllowed = 'all'
  const target = hitTest(point) ?? payload.elementId
  dispatch('dragenter', target, data, payload)
  const accepted = dispatch('dragover', target, data, payload).defaultPrevented
  if (!accepted) {
    dispatch('dragleave', target, data, payload)
    return
  }
  data.mode = 'read-only'
  dispatch('drop', target, data, payload)
}
