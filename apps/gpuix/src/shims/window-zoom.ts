/**
 * Whole-window zoom for the GPUIX client: the stand-in for the Tauri
 * webview's `setZoom`, which `hooks/use-ui-zoom.ts` calls on the desktop.
 * GPUIX 0.11 has no scale or rem-size API, so the zoom lives at the boundary
 * between React and the native tree and follows browser zoom semantics: the
 * app keeps working in CSS px, and one CSS px paints as `scale` window px.
 *
 * - Out: every length in a `setStyle` payload and in the length-carrying
 *   custom props is multiplied by the scale before it is queued.
 * - In: element bounds, the window size, scroll offsets and event
 *   coordinates are divided by it, so a measured box and the style derived
 *   from it stay in one unit.
 *
 * A zoom change resends the style and length props of every mounted host
 * node from its current props, then republishes the window size, which fires
 * `resize` like a browser does. Nothing is wrapped until the first scale
 * other than 1, so an unzoomed window runs the unmodified GPUIX path.
 *
 * The React root is found through the DevTools global hook, the one public
 * place react-reconciler hands out its `FiberRoot` (`captureZoomRoots`,
 * called from `main.tsx` with the reconciler `@gpuix/react` renders with).
 *
 * GPUIX automation reads and clicks in window px, so automated clicks at a
 * scale other than 1 land off target; drive zoomed windows by keys.
 */

import { createRendererState, serializeCustomProp } from '@gpuix/native/host'
import type { EventPayload, NativeRenderer } from '@gpuix/react'
import { syncViewport } from '../compat/viewport'
import { log } from '../log'

type Style = Record<string, unknown>

interface HostInstance {
  id: number
  type: string
  props: Record<string, unknown>
}

interface QueueRenderer {
  setStyle(id: number, style: object): void
  setCustomProp(id: number, key: string, value: unknown): void
  flushMutations(): void
}

interface Container {
  renderer: QueueRenderer
  nativeRenderer: NativeRenderer
}

interface Fiber {
  tag: number
  child: Fiber | null
  sibling: Fiber | null
  stateNode: unknown
  memoizedState: unknown
}

interface FiberRoot {
  current: Fiber
  containerInfo: Container
}

const LENGTH_KEYS = new Set([
  'gap',
  'rowGap',
  'columnGap',
  'flexBasis',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'top',
  'right',
  'bottom',
  'left',
  'borderWidth',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'outlineWidth',
  'outlineOffset',
  'fontSize',
  'lineHeight',
  'scrollbarWidth'
])
const STATE_KEYS = ['hover', 'active', 'focusVisible'] as const
const SHADOW_KEYS = ['offsetX', 'offsetY', 'blurRadius', 'spreadRadius'] as const
const MOTION_KEYS = ['initial', 'animate', 'exit'] as const
/** Custom props that carry window px: `<anchored>`, `<virtual-list>`, `motion`, element themes. */
const LENGTH_PROPS = new Set([
  'position',
  'offset',
  'gap',
  'snapMargin',
  'estimatedItemHeight',
  'motion',
  'theme'
])
/** React's Offscreen fiber: a hidden Suspense or Activity subtree keeps its nodes with `visibility: hidden`. */
const OFFSCREEN_TAG = 22
const PX = /^(-?\d*\.?\d+)px$/

let scale = 1
const roots = new Set<FiberRoot>()
const wrapped = new WeakSet<object>()

function length(value: unknown, by: number): unknown {
  if (typeof value === 'number') return value * by
  if (typeof value === 'string') {
    const match = PX.exec(value)
    if (match) return `${Number(match[1]) * by}px`
  }
  return value
}

function scaleShadow(shadow: unknown, by: number): unknown {
  if (Array.isArray(shadow)) return shadow.map((one) => scaleShadow(one, by))
  if (!shadow || typeof shadow !== 'object') return shadow
  const out: Style = { ...(shadow as Style) }
  for (const key of SHADOW_KEYS)
    if (typeof out[key] === 'number') out[key] = (out[key] as number) * by
  return out
}

export function scaleStyle(style: Style, by: number): Style {
  const out: Style = {}
  for (const key in style) {
    const value = style[key]
    if (LENGTH_KEYS.has(key)) out[key] = length(value, by)
    else if (key === 'boxShadow') out[key] = scaleShadow(value, by)
    else if ((STATE_KEYS as readonly string[]).includes(key) && value && typeof value === 'object')
      out[key] = scaleStyle(value as Style, by)
    else out[key] = value
  }
  return out
}

function scaleNumbers(value: unknown, by: number): unknown {
  if (typeof value === 'number') return value * by
  if (Array.isArray(value)) return value.map((item) => scaleNumbers(item, by))
  if (value && typeof value === 'object') {
    const out: Style = {}
    for (const [key, item] of Object.entries(value)) out[key] = scaleNumbers(item, by)
    return out
  }
  return value
}

export function scaleCustomProp(key: string, value: unknown, by: number): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value
  switch (key) {
    case 'theme': {
      const theme = value as Style
      return theme.metrics ? { ...theme, metrics: scaleNumbers(theme.metrics, by) } : value
    }
    case 'motion': {
      const motion: Style = { ...(value as Style) }
      for (const phase of MOTION_KEYS) {
        const target = motion[phase]
        if (target && typeof target === 'object') motion[phase] = scaleStyle(target as Style, by)
      }
      return motion
    }
    default:
      return scaleNumbers(value, by)
  }
}

/** Event payloads arrive in window px; the app reads CSS px. */
export function scaleEvent(event: EventPayload, by: number): EventPayload {
  if (
    event.x === undefined &&
    event.width === undefined &&
    event.scrollX === undefined &&
    !event.precise
  )
    return event
  const out = { ...event }
  if (out.x !== undefined) out.x /= by
  if (out.y !== undefined) out.y /= by
  if (out.width !== undefined) out.width /= by
  if (out.height !== undefined) out.height /= by
  if (out.scrollX !== undefined) out.scrollX /= by
  if (out.scrollY !== undefined) out.scrollY /= by
  if (out.precise) {
    if (out.deltaX !== undefined) out.deltaX /= by
    if (out.deltaY !== undefined) out.deltaY /= by
  }
  return out
}

/**
 * Hand react-reconciler a DevTools hook and have it report its commits there,
 * unless a real DevTools is attached. `reconciler` is the instance
 * `@gpuix/react` renders with; `injectIntoDevTools` reads the hook when it is
 * called, so this works after `@gpuix/react` has loaded, before or after the
 * first commit.
 */
export function captureZoomRoots(reconciler: { injectIntoDevTools(): unknown }): void {
  const global = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown> }
  const capture = (_rendererId: number, root: FiberRoot) => {
    if (!roots.has(root)) roots.add(root)
  }
  const existing = global.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (existing) {
    const previous = existing.onCommitFiberRoot as ((...args: unknown[]) => void) | undefined
    existing.onCommitFiberRoot = (id: number, root: FiberRoot, ...rest: unknown[]) => {
      capture(id, root)
      previous?.call(existing, id, root, ...rest)
    }
  } else {
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onCommitFiberRoot: capture,
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {}
    }
  }
  reconciler.injectIntoDevTools()
}

function wrapQueue(queue: QueueRenderer): void {
  if (wrapped.has(queue)) return
  wrapped.add(queue)
  const setStyle = queue.setStyle.bind(queue)
  const setCustomProp = queue.setCustomProp.bind(queue)
  queue.setStyle = (id, style) =>
    setStyle(id, scale === 1 ? style : scaleStyle(style as Style, scale))
  queue.setCustomProp = (id, key, value) =>
    setCustomProp(
      id,
      key,
      scale === 1 || !LENGTH_PROPS.has(key) ? value : scaleCustomProp(key, value, scale)
    )
}

type Methods = Record<string, ((...args: never[]) => unknown) | undefined>

function wrapNative(native: NativeRenderer): void {
  if (wrapped.has(native)) return
  wrapped.add(native)
  const methods = native as unknown as Methods
  const inbound = <T>(name: string, map: (value: T) => T) => {
    const original = methods[name]
    if (!original) return
    methods[name] = (...args: never[]) => {
      const value = original.apply(native, args) as T
      return scale === 1 || value == null ? value : map(value)
    }
  }
  const outbound = (name: string, map: (args: number[]) => number[]) => {
    const original = methods[name]
    if (!original) return
    methods[name] = (...args: never[]) =>
      original.apply(native, (scale === 1 ? args : map(args as unknown as number[])) as never[])
  }
  const box = (b: { x: number; y: number; width: number; height: number }) => ({
    x: b.x / scale,
    y: b.y / scale,
    width: b.width / scale,
    height: b.height / scale
  })
  inbound('getElementBounds', box)
  inbound<{ width: number; height: number }>('getWindowSize', (s) => ({
    width: s.width / scale,
    height: s.height / scale
  }))
  inbound<number[]>('getScrollOffset', (xy) => xy.map((v) => v / scale))
  inbound<number[]>('getListScrollTop', ([index, offset]) => [index, offset / scale])
  outbound('scrollTo', ([id, x, y]) => [id, x * scale, y * scale])
  outbound('scrollToItem', ([id, index, offset]) => [
    id,
    index,
    offset == null ? offset : offset * scale
  ])
  outbound('getElementsAt', ([x, y]) => [x * scale, y * scale])

  const state = createRendererState(native as never) as unknown as {
    dispatch(event: EventPayload): boolean
  }
  const dispatch = state.dispatch.bind(state)
  state.dispatch = (event) => dispatch(scale === 1 ? event : scaleEvent(event, scale))
}

function isHostInstance(node: unknown): node is HostInstance {
  return (
    !!node &&
    typeof (node as HostInstance).id === 'number' &&
    typeof (node as HostInstance).props === 'object'
  )
}

/** Resend what the scale changes for every node in the committed tree. */
function resend(root: FiberRoot): number {
  const queue = root.containerInfo.renderer
  let nodes = 0
  const stack: Array<[Fiber, boolean]> = root.current.child ? [[root.current.child, false]] : []
  while (stack.length > 0) {
    const [fiber, inHidden] = stack.pop() as [Fiber, boolean]
    if (fiber.sibling) stack.push([fiber.sibling, inHidden])
    const hidden = inHidden || (fiber.tag === OFFSCREEN_TAG && fiber.memoizedState !== null)
    if (fiber.child) stack.push([fiber.child, hidden])
    const node = fiber.stateNode
    if (!isHostInstance(node)) continue
    nodes += 1
    const style = node.props.style as Style | undefined
    if (hidden) {
      const { hover: _hover, active: _active, ...base } = style ?? {}
      queue.setStyle(node.id, { ...base, visibility: 'hidden' })
    } else if (style && Object.keys(style).length > 0) {
      queue.setStyle(node.id, style)
    }
    for (const key of LENGTH_PROPS) {
      if (!(key in node.props)) continue
      if (node.type === 'div' || node.type === 'text') {
        if (key !== 'motion') continue
      }
      queue.setCustomProp(
        node.id,
        key,
        serializeCustomProp(node.props[key] as Parameters<typeof serializeCustomProp>[0])
      )
    }
  }
  queue.flushMutations()
  return nodes
}

/** Paint one CSS px as `next` window px across the whole window. */
export function setWindowZoom(next: number): void {
  if (next === scale) return
  if (roots.size === 0) {
    log.warn('window-zoom', `no React root captured; zoom ${next} not applied`)
    throw new Error('GPUIX window zoom: no React root was captured (captureZoomRoots)')
  }
  const started = performance.now()
  for (const root of roots) {
    wrapQueue(root.containerInfo.renderer)
    wrapNative(root.containerInfo.nativeRenderer)
  }
  const previous = scale
  scale = next
  let nodes = 0
  for (const root of roots) {
    nodes += resend(root)
    syncViewport(root.containerInfo.nativeRenderer)
  }
  log.info(
    'window-zoom',
    `zoom ${previous} -> ${next}: ${nodes} nodes restyled in ${Math.round(performance.now() - started)} ms`
  )
}

export function windowZoom(): number {
  return scale
}
