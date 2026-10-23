/**
 * `react-dom` for shared code. A portal goes to the GPUIX element its
 * container stands for, or to the window-wide overlay layer `CompatRoot`
 * mounts (for `document.body` and anything untracked).
 */

import { createPortal as gpuixPortal, flushSync as gpuixFlushSync, type PublicInstance } from '@gpuix/react'
import type { ReactNode } from 'react'
import { CompatElement, trackedInstance } from './dom-node'
import { compatWarn } from './log'

let overlay: PublicInstance | null = null

export function setOverlayLayer(instance: PublicInstance | null): void {
  overlay = instance
}

export function createPortal(children: ReactNode, container: unknown, key?: string | null): ReactNode {
  const target =
    container instanceof CompatElement ? (trackedInstance(container.elementId) as PublicInstance | undefined) : undefined
  const into = target ?? overlay
  if (!into) {
    compatWarn('portal', 'createPortal before the overlay layer mounted')
    return null
  }
  return gpuixPortal(children, into, key)
}

export function flushSync<T>(fn: () => T): T {
  return gpuixFlushSync(fn)
}

export function unstable_batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  return fn(a)
}

export function findDOMNode(): null {
  compatWarn('dom-method-noop', 'findDOMNode')
  return null
}

export function preload(): void {}
export function preconnect(): void {}
export function prefetchDNS(): void {}
export function preinit(): void {}

export const version = '19.3.1'

export default { createPortal, flushSync, unstable_batchedUpdates, findDOMNode, version }
