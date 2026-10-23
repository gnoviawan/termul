/**
 * ResizeObserver backed by GPUIX `onLayout`, which every element with a user
 * ref carries. `observe` reports the current box at once, as the DOM does;
 * later reports come from the native layout callback (size changes only).
 */

import type { EventPayload } from '@gpuix/react'
import { compatRenderer, nodeFor, type CompatElement } from './dom-node'

type Callback = (entries: ResizeEntry[], observer: CompatResizeObserver) => void

interface ResizeEntry {
  target: CompatElement
  contentRect: { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }
  borderBoxSize: { inlineSize: number; blockSize: number }[]
  contentBoxSize: { inlineSize: number; blockSize: number }[]
}

const observers = new Map<number, Set<CompatResizeObserver>>()

function entry(target: CompatElement, width: number, height: number): ResizeEntry {
  const box = [{ inlineSize: width, blockSize: height }]
  return {
    target,
    contentRect: { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height },
    borderBoxSize: box,
    contentBoxSize: box
  }
}

export function layoutListener(payload: EventPayload): void {
  const set = observers.get(payload.elementId)
  if (!set) return
  const target = nodeFor(payload.elementId)
  const e = entry(target, payload.width ?? 0, payload.height ?? 0)
  for (const observer of set) observer.deliver([e])
}

export class CompatResizeObserver {
  private readonly targets = new Set<number>()

  constructor(private readonly callback: Callback) {}

  deliver(entries: ResizeEntry[]): void {
    this.callback(entries, this)
  }

  observe(target: unknown): void {
    if (!(target && typeof target === 'object' && 'elementId' in target)) return
    const id = (target as CompatElement).elementId
    this.targets.add(id)
    let set = observers.get(id)
    if (!set) {
      set = new Set()
      observers.set(id, set)
    }
    set.add(this)
    const bounds = compatRenderer()?.getElementBounds(id)
    if (bounds) queueMicrotask(() => this.deliver([entry(nodeFor(id), bounds.width, bounds.height)]))
  }

  unobserve(target: unknown): void {
    const id = (target as CompatElement | null)?.elementId
    if (id === undefined) return
    this.targets.delete(id)
    observers.get(id)?.delete(this)
  }

  disconnect(): void {
    for (const id of this.targets) observers.get(id)?.delete(this)
    this.targets.clear()
  }
}
