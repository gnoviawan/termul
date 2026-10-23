/**
 * Two absolute-positioning idioms GPUIX cannot express (no % offsets, no
 * transforms), rebuilt from boxes it has:
 *
 * - Centering: `top-1/2 -translate-y-1/2` (and the `left-1/2 -translate-x-1/2`
 *   twin). The element sits in a pointer-transparent absolute wrapper that
 *   spans the centred axis and centres it with flex; the element's own px
 *   offsets move to the wrapper.
 * - Popups: `bottom-full` / `top-full` put a menu just above or below its
 *   positioned parent. Such a menu must also paint over later siblings (the
 *   chat list paints after the composer), so it becomes a deferred
 *   `<anchored>` on the parent's side, with the margin as the gap. A menu
 *   inset on both sides (`left-2 right-2`) takes the parent's width minus the
 *   insets, measured from the parent once it is laid out.
 */

import type { PublicInstance, StyleDesc } from '@gpuix/react'
import { type ReactElement, useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'
import { compatRenderer, treeIndex } from './dom-node'
import { subscribeViewport, viewportWidth } from './viewport'

export interface Placement {
  centerX: boolean
  centerY: boolean
  /** The parent edge a `top-full` / `bottom-full` popup attaches to. */
  popup: 'top' | 'bottom' | null
}

const OFFSET_KEYS = ['top', 'right', 'bottom', 'left'] as const

/**
 * Take the placement tokens out of a class list. Centering needs both halves
 * of the idiom (`top-1/2` and `-translate-y-1/2`); a lone half stays in the
 * list for tw() to report.
 */
export function liftPlacement(tokens: string[]): { placement: Placement | null; rest: string[] } {
  const has = (token: string) => tokens.includes(token)
  const centerY = has('top-1/2') && has('-translate-y-1/2')
  const centerX = has('left-1/2') && has('-translate-x-1/2')
  const popup = has('bottom-full') ? 'top' : has('top-full') ? 'bottom' : null
  if (!centerX && !centerY && !popup) return { placement: null, rest: tokens }
  const drop = new Set<string>()
  if (centerY) drop.add('top-1/2').add('-translate-y-1/2')
  if (centerX) drop.add('left-1/2').add('-translate-x-1/2')
  if (popup) drop.add('bottom-full').add('top-full')
  return { placement: { centerX, centerY, popup }, rest: tokens.filter((t) => !drop.has(t)) }
}

type Offsets = Partial<Record<(typeof OFFSET_KEYS)[number], number>>

function splitOffsets(style: StyleDesc): { offsets: Offsets; inner: StyleDesc } {
  const inner: Record<string, unknown> = { ...style }
  const offsets: Offsets = {}
  for (const key of OFFSET_KEYS) {
    const value = inner[key]
    delete inner[key]
    if (typeof value === 'number') offsets[key] = value
  }
  delete inner.position
  return { offsets, inner: inner as StyleDesc }
}

/** The style the element itself keeps, and how to wrap it; `null` when the element is not absolutely placed. */
export function placeStyle(style: StyleDesc, placement: Placement): { inner: StyleDesc; wrap(element: ReactElement, key?: string): ReactElement } | null {
  if (style.position !== 'absolute') return null
  const { offsets, inner } = splitOffsets(style)
  if (placement.popup) {
    const marginKey = placement.popup === 'top' ? 'marginBottom' : 'marginTop'
    const gap = typeof inner[marginKey] === 'number' ? (inner[marginKey] as number) : 0
    const own: Record<string, unknown> = { ...inner }
    delete own[marginKey]
    return {
      inner: own as StyleDesc,
      wrap: (element, key) => jsx(AnchoredPopup, { side: placement.popup, gap, offsets, children: element }, key)
    }
  }
  const wrapper: Record<string, unknown> = {
    position: 'absolute',
    display: 'flex',
    pointerEvents: 'none',
    ...offsets
  }
  if (placement.centerY) {
    wrapper.top = 0
    wrapper.bottom = 0
    wrapper.alignItems = 'center'
  }
  if (placement.centerX) {
    wrapper.left = 0
    wrapper.right = 0
    wrapper.justifyContent = 'center'
    if (!placement.centerY) wrapper.alignItems = 'flex-start'
  }
  return {
    inner: { ...inner, position: 'relative', flexShrink: 0 } as StyleDesc,
    wrap: (element, key) => jsx('div', { style: wrapper, children: element }, key)
  }
}

interface AnchoredPopupProps {
  side: 'top' | 'bottom'
  gap: number
  offsets: Offsets
  children: ReactElement
}

/** Parent width, read from the laid-out tree; follows window resizes. */
function useParentWidth(stretch: boolean): [(instance: PublicInstance | null) => void, number | null] {
  const [id, setId] = useState<number | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const viewport = useSyncExternalStore(stretch ? subscribeViewport : noSubscribe, viewportWidth)
  const ref = useCallback((instance: PublicInstance | null) => {
    setId(instance ? (instance as unknown as { id: number }).id : null)
  }, [])
  useLayoutEffect(() => {
    if (!stretch || id === null) return
    const parent = treeIndex().parent.get(id)
    const bounds = parent === undefined ? null : compatRenderer()?.getElementBounds(parent)
    if (bounds) setWidth(bounds.width)
  }, [stretch, id, viewport])
  return [ref, width]
}

const noSubscribe = () => () => {}

function AnchoredPopup({ side, gap, offsets, children }: AnchoredPopupProps): ReactElement {
  const stretch = offsets.left !== undefined && offsets.right !== undefined
  const [ref, parentWidth] = useParentWidth(stretch)
  const align = offsets.left === undefined && offsets.right !== undefined ? 'end' : 'start'
  const x = align === 'end' ? -(offsets.right ?? 0) : (offsets.left ?? 0)
  const width = stretch && parentWidth !== null ? parentWidth - (offsets.left ?? 0) - (offsets.right ?? 0) : undefined
  return jsx('anchored' as never, {
    ref,
    side,
    align,
    gap,
    offset: { x, y: 0 },
    fit: 'snap',
    deferred: true,
    style: { backgroundColor: 'transparent', ...(width !== undefined ? { width } : {}) },
    children: width !== undefined ? jsx('div', { style: { display: 'flex', flexDirection: 'column', width }, children }) : children
  })
}

const FILL_MINUS = /^w-\[calc\(100%-(\d*\.?\d+)(px|rem)\)\]$/

/**
 * `w-[calc(100%-2.75rem)]`: GPUIX widths are px or a plain percent, so the
 * percent part becomes a full-width row wrapper whose padding takes the
 * subtracted length, and the element grows inside it. With `mx-auto` the
 * padding splits evenly (the element stays centred); with `ml-auto` it goes
 * on the left; otherwise on the right.
 */
export function liftFillMinus(tokens: string[]): { minus: number | null; rest: string[] } {
  let minus: number | null = null
  const rest = tokens.filter((token) => {
    const match = token.match(FILL_MINUS)
    if (!match) return true
    minus = Number.parseFloat(match[1]) * (match[2] === 'rem' ? 16 : 1)
    return false
  })
  return { minus, rest }
}

export function wrapFillMinus(
  element: ReactElement<{ style?: StyleDesc }>,
  minus: number,
  side: 'both' | 'left' | 'right',
  key?: string
): ReactElement {
  const padding =
    side === 'both'
      ? { paddingLeft: minus / 2, paddingRight: minus / 2 }
      : side === 'left'
        ? { paddingLeft: minus }
        : { paddingRight: minus }
  return jsx('div', { style: { display: 'flex', flexDirection: 'row', width: '100%', flexShrink: 0, ...padding }, children: element }, key)
}
