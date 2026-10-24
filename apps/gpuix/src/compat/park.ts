/**
 * Takes hidden panes out of the GPUIX frame while React keeps them mounted.
 *
 * Termul keeps inactive chats, tabs and project trees mounted so their state
 * survives (`absolute inset-0 invisible`, AD-13). A browser lays such a
 * subtree out once and then skips it. GPUI rebuilds and lays out every
 * element reachable from the window root on every frame, and `visibility:
 * hidden` only skips the paint, so each hidden pane cost the UI thread its
 * full size on every frame (tools/perf/hidden: 8 panes of 150 rows, 81% of a
 * core hidden against 14% parked).
 *
 * This wraps the renderer's `applyBatch`. When an element's style becomes a
 * hidden full-bleed overlay, the element moves under a native node that is
 * not reachable from the root, and an empty placeholder takes its place among
 * its siblings. React never sees the move: ops that place a sibling before the
 * parked element, or move the parked element itself, are rewritten to the
 * placeholder. When the style turns visible the element goes back in the
 * placeholder's slot. Its subtree, React state and native state (scroll
 * offsets, terminals, list windows) are untouched throughout.
 *
 * Only `position: absolute` with all four insets at 0 qualifies: such an
 * element takes no room in its parent's layout, so removing it changes no
 * sibling's box.
 */

import type { StyleDesc } from '@gpuix/react'

export interface BatchRenderer {
  applyBatch(json: string): number[]
}

type Op = [string, ...unknown[]]

/** Far above any id GPUIX allocates (a counter from 1) and below 2^53. */
const PARK_BASE = 2 ** 52
const PLACEHOLDER: StyleDesc = { position: 'absolute', width: 0, height: 0, visibility: 'hidden' }

export function parksHidden(style: StyleDesc | null | undefined): boolean {
  return (
    style?.visibility === 'hidden' &&
    style.position === 'absolute' &&
    style.top === 0 &&
    style.right === 0 &&
    style.bottom === 0 &&
    style.left === 0
  )
}

export interface Parking {
  /** Elements currently parked. */
  parked(): number
  uninstall(): void
}

export function parkHiddenPanes(renderer: BatchRenderer): Parking {
  const native = renderer.applyBatch.bind(renderer)
  /** Native parent of every element placed since install; placeholders included. */
  const parentOf = new Map<number, number>()
  /** Elements whose last style parks them. */
  const wantsPark = new Set<number>()
  /** Parked element -> the placeholder holding its slot. */
  const placeholderOf = new Map<number, number>()
  let nextId = PARK_BASE + 1
  let rootCreated = false

  const applyBatch = (json: string): number[] => {
    const ops = JSON.parse(json) as Op[]
    const out: Op[] = []
    const touched = new Set<number>()
    let rewritten = false
    const swap = (id: number): number => {
      const placeholder = placeholderOf.get(id)
      if (placeholder === undefined) return id
      rewritten = true
      return placeholder
    }

    for (const op of ops) {
      switch (op[0]) {
        case 'appendChild': {
          const child = swap(op[2] as number)
          op[2] = child
          parentOf.set(child, op[1] as number)
          touched.add(op[2] as number)
          break
        }
        case 'insertBefore': {
          const child = swap(op[2] as number)
          op[2] = child
          op[3] = swap(op[3] as number)
          parentOf.set(child, op[1] as number)
          touched.add(child)
          break
        }
        case 'setStyle': {
          const id = op[1] as number
          if (parksHidden(op[2] as StyleDesc)) wantsPark.add(id)
          else wantsPark.delete(id)
          touched.add(id)
          break
        }
        case 'destroyElement': {
          const id = op[1] as number
          const placeholder = placeholderOf.get(id)
          if (placeholder !== undefined) {
            placeholderOf.delete(id)
            out.push(op, ['destroyElement', placeholder])
            rewritten = true
            continue
          }
          break
        }
      }
      out.push(op)
    }

    for (const id of touched) {
      const placeholder = placeholderOf.get(id)
      if (wantsPark.has(id) && placeholder === undefined) {
        const parent = parentOf.get(id)
        if (parent === undefined) continue
        const slot = nextId++
        if (!rootCreated) out.push(['createElement', PARK_BASE, 'div'])
        rootCreated = true
        out.push(
          ['createElement', slot, 'div'],
          ['setStyle', slot, PLACEHOLDER],
          ['insertBefore', parent, slot, id],
          ['appendChild', PARK_BASE, id]
        )
        placeholderOf.set(id, slot)
        parentOf.set(slot, parent)
        parentOf.set(id, PARK_BASE)
        rewritten = true
      } else if (!wantsPark.has(id) && placeholder !== undefined) {
        const parent = parentOf.get(placeholder)
        if (parent === undefined) continue
        out.push(['insertBefore', parent, id, placeholder], ['destroyElement', placeholder])
        placeholderOf.delete(id)
        parentOf.set(id, parent)
        rewritten = true
      }
    }

    const destroyed = native(rewritten ? JSON.stringify(out) : json)
    for (const id of destroyed) {
      parentOf.delete(id)
      wantsPark.delete(id)
    }
    return destroyed
  }

  renderer.applyBatch = applyBatch
  return {
    parked: () => placeholderOf.size,
    uninstall: () => {
      if (renderer.applyBatch === applyBatch) renderer.applyBatch = native
    }
  }
}
