/**
 * framer-motion for the compat prototype: `motion.<tag>` renders the plain
 * tag at its `animate` end state (opacity only; transforms have no GPUIX
 * target) and drops every motion prop. Animation fidelity is not attempted.
 */

import { createContext, createElement, forwardRef, type ReactNode } from 'react'
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
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) if (!MOTION_PROPS.has(k)) rest[k] = v
    const animate = props.animate
    if (animate && typeof animate === 'object' && 'opacity' in (animate as object)) {
      const opacity = (animate as { opacity: unknown }).opacity
      if (typeof opacity === 'number' && opacity < 1)
        rest.style = { ...(rest.style as object), opacity }
    }
    if (props.layout || props.layoutId) compatWarn('motion-unsupported', 'layout animation')
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
export const Reorder = {
  Group: motionComponent('div'),
  Item: motionComponent('div')
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
