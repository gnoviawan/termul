/**
 * framer-motion for the compat prototype: `motion.<tag>` renders the plain
 * tag at its `animate` end state (opacity, and a `rotate` that the icons
 * below bake in, `color.ts`; other transforms have no GPUIX target) and drops every motion prop. Animation fidelity is not attempted.
 */

import {
  type ComponentType,
  createContext,
  createElement,
  forwardRef,
  type ReactNode,
  useContext,
  useEffect,
  useRef
} from 'react'
import { RotateContext } from '../color'
import { notePointerDragRelease } from '../dnd'
import { clickWithheldByCapture } from '../events'
import { compatWarn } from '../log'

const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileInView',
  'whileDrag',
  'layout',
  'layoutId',
  'layoutDependency',
  'layoutScroll',
  'drag',
  'dragConstraints',
  'dragElastic',
  'dragMomentum',
  'dragListener',
  'dragControls',
  'onAnimationStart',
  'onAnimationComplete',
  'onUpdate',
  'onDragStart',
  'onDragEnd',
  'onDrag',
  'onLayoutAnimationComplete',
  'custom',
  'inherit',
  'viewport',
  'values',
  'axis',
  'onReorder',
  'value',
  'as'
])

const cache = new Map<string, unknown>()

function motionComponent(tag: string) {
  const hit = cache.get(tag)
  if (hit) return hit
  const Component = forwardRef<unknown, Record<string, unknown>>(function Motion(props, ref) {
    const outerRotate = useContext(RotateContext)
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) if (!MOTION_PROPS.has(k)) rest[k] = v
    const animate = props.animate
    if (animate && typeof animate === 'object' && 'opacity' in (animate as object)) {
      const opacity = (animate as { opacity: unknown }).opacity
      if (typeof opacity === 'number' && opacity < 1)
        rest.style = { ...(rest.style as object), opacity }
    }
    if (props.layout || props.layoutId) compatWarn('motion-unsupported', 'layout animation')
    const rotate = animate && typeof animate === 'object' ? (animate as { rotate?: unknown }).rotate : undefined
    if (typeof rotate === 'number') {
      rest.children = createElement(RotateContext.Provider, { value: outerRotate + rotate }, rest.children as ReactNode)
    }
    return createElement(tag, { ...rest, ref })
  })
  cache.set(tag, Component)
  return Component
}

export const motion = new Proxy({} as Record<string, unknown>, {
  get: (_t, tag: string) => motionComponent(tag)
})
export const m = motion

export function AnimatePresence({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function LayoutGroup({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export function MotionConfig({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export const useReducedMotion = () => true
export const useIsPresent = () => true
export const cubicBezier = (..._args: number[]) => (t: number) => t

type Axis = 'x' | 'y'
type Point = { x: number; y: number }
interface Span {
  min: number
  max: number
}
type Measurable = { getBoundingClientRect(): { x: number; y: number; width: number; height: number } }
type PointerView = { clientX: number; clientY: number; button: number; buttons: number }
type DragInfo = { point: Point; offset: Point; delta: Point; velocity: Point }
type DragHandler = (event: PointerView, info: DragInfo) => void

interface ReorderGroup {
  axis: Axis
  values: readonly unknown[]
  onReorder: (next: unknown[]) => void
  /** Each item's current box along the axis, by its `value`. */
  spans: Map<unknown, () => Span | null>
}

/** The item being pressed or dragged; one at a time, as framer-motion's drag lock. */
interface ItemDrag {
  group: ReorderGroup | null
  value: unknown
  props: () => Record<string, unknown>
  node: (Measurable & { elementId?: number }) | null
  origin: Point
  last: Point
  /** The item's box along the axis when the drag began; the pointer offset moves it. */
  start: Span | null
  started: boolean
}

const ReorderContext = createContext<ReorderGroup | null>(null)
/** Pixels a press travels before it becomes a drag, as framer-motion's pan threshold. */
const PAN_THRESHOLD = 3
let active: ItemDrag | null = null

function spanOf(node: Measurable | null, axis: Axis): Span | null {
  if (!node) return null
  const r = node.getBoundingClientRect()
  return axis === 'y' ? { min: r.y, max: r.y + r.height } : { min: r.x, max: r.x + r.width }
}

/** framer-motion's checkReorder: one neighbour per move, in the direction of travel. */
function checkReorder(group: ReorderGroup, value: unknown, dragged: Span, velocity: number): void {
  const index = group.values.indexOf(value)
  const step = velocity > 0 ? 1 : -1
  const next = group.values[index + step]
  if (index < 0 || next === undefined) return
  const neighbour = group.spans.get(next)?.()
  if (!neighbour) return
  const centre = (neighbour.min + neighbour.max) / 2
  if (step === 1 ? dragged.max > centre : dragged.min < centre) {
    const order = [...group.values]
    order.splice(index, 1)
    order.splice(index + step, 0, value)
    group.onReorder(order)
  }
}

function dragInfo(s: ItemDrag, point: Point): DragInfo {
  const delta = { x: point.x - s.last.x, y: point.y - s.last.y }
  return { point, offset: { x: point.x - s.origin.x, y: point.y - s.origin.y }, delta, velocity: delta }
}

function endDrag(event: PointerView): void {
  const s = active
  active = null
  if (!s) return
  const point = { x: event.clientX, y: event.clientY }
  if (!s.started) {
    if (s.node?.elementId !== undefined) clickWithheldByCapture(s.node.elementId, point)
    return
  }
  notePointerDragRelease(point)
  ;(s.props().onDragEnd as DragHandler | undefined)?.(event, dragInfo(s, point))
}

function moveDrag(event: PointerView): void {
  const s = active
  if (!s) return
  if (event.buttons === 0) return endDrag(event)
  const point = { x: event.clientX, y: event.clientY }
  if (point.x === s.last.x && point.y === s.last.y) return
  const axis = s.group?.axis ?? 'y'
  const props = s.props()
  if (!s.started) {
    if (Math.hypot(point.x - s.origin.x, point.y - s.origin.y) < PAN_THRESHOLD) return
    s.started = true
    s.start = spanOf(s.node, axis)
    ;(props.onDragStart as DragHandler | undefined)?.(event, dragInfo(s, point))
  }
  const info = dragInfo(s, point)
  s.last = point
  if (s.group && s.start && info.velocity[axis] !== 0) {
    const offset = info.offset[axis]
    checkReorder(s.group, s.value, { min: s.start.min + offset, max: s.start.max + offset }, info.velocity[axis])
  }
  ;(props.onDrag as DragHandler | undefined)?.(event, info)
}

function chain<E>(own: unknown, next: (event: E) => void): (event: E) => void {
  return (event) => {
    ;(own as ((event: E) => void) | undefined)?.(event)
    next(event)
  }
}

const ReorderGroupComponent = forwardRef<unknown, Record<string, unknown>>(function ReorderGroup(props, ref) {
  const spans = useRef(new Map<unknown, () => Span | null>()).current
  const group: ReorderGroup = {
    axis: (props.axis as Axis | undefined) ?? 'y',
    values: (props.values as unknown[] | undefined) ?? [],
    onReorder: (props.onReorder as ReorderGroup['onReorder'] | undefined) ?? (() => {}),
    spans
  }
  const Div = motionComponent('div') as ComponentType<Record<string, unknown>>
  return (
    <ReorderContext.Provider value={group}>
      <Div {...props} ref={ref} />
    </ReorderContext.Provider>
  )
})

/**
 * Reorder.Item: a press that travels 3 px drags the item, each move runs
 * checkReorder with the item's starting box offset by the pointer, and
 * `onDragStart`/`onDrag`/`onDragEnd` get framer's info (`point`, `offset`,
 * `delta`, `velocity`). The list reorders live; the item does not follow the
 * pointer, since GPUIX has no transforms. The item takes the press, move and
 * release so GPUIX captures the pointer for the drag; capture withholds the
 * click from the row's own buttons, so a release without a drag replays it.
 */
const ReorderItemComponent = forwardRef<unknown, Record<string, unknown>>(function ReorderItem(props, ref) {
  const group = useContext(ReorderContext)
  const node = useRef<ItemDrag['node']>(null)
  const latest = useRef(props)
  latest.current = props
  const { value } = props
  const axis = group?.axis ?? 'y'
  if (group) group.spans.set(value, () => spanOf(node.current, axis))
  useEffect(() => () => void group?.spans.delete(value), [group?.spans, value])
  const setRef = (instance: unknown) => {
    node.current = instance as ItemDrag['node']
    if (typeof ref === 'function') ref(instance)
    else if (ref) ref.current = instance
  }
  const enabled = props.drag !== false && props.dragListener !== false
  const press = (event: PointerView & { __reorderClaimed?: boolean }) => {
    if (!enabled || event.button !== 0 || event.__reorderClaimed) return
    event.__reorderClaimed = true
    const point = { x: event.clientX, y: event.clientY }
    active = { group, value, props: () => latest.current, node: node.current, origin: point, last: point, start: null, started: false }
  }
  const Div = motionComponent('div') as ComponentType<Record<string, unknown>>
  return (
    <Div
      {...props}
      ref={setRef}
      onPointerDown={chain(props.onPointerDown, press)}
      onPointerMove={chain(props.onPointerMove, moveDrag)}
      onPointerUp={chain(props.onPointerUp, endDrag)}
    />
  )
})

export const Reorder = {
  Group: ReorderGroupComponent,
  Item: ReorderItemComponent
}
export type Transition = Record<string, unknown>
export type TargetAndTransition = Record<string, unknown>
export type HTMLMotionProps<_T> = Record<string, unknown>
export const domAnimation = {}
export const domMax = {}
export function LazyMotion({ children }: { children?: ReactNode }) {
  return <>{children}</>
}
export const PresenceContext = createContext<null>(null)
export const usePresence = () => [true, () => {}] as const
export const useAnimate = () => [{ current: null }, async () => {}] as const
export const useMotionValue = <T,>(v: T) => ({ get: () => v, set: () => {}, on: () => () => {} })
export const useTransform = (_v: unknown, _i?: unknown, o?: unknown[]) => ({ get: () => o?.[0] })
export const useSpring = useMotionValue
export const animate = () => ({ stop() {}, then: (f: () => void) => f() })
