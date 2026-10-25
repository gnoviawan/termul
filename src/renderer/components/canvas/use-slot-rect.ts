/**
 * The viewport rectangle of the panel slot a canvas covers, shared by every
 * canvas host: the DOM iframe (`CanvasShell`) and a desktop shell's native
 * editor view.
 */

import { useEffect, useState } from 'react'

export interface SlotRect {
  left: number
  top: number
  width: number
  height: number
}

function sameRect(a: SlotRect | null, b: SlotRect): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  )
}

/** The slot's viewport rectangle, followed every frame while there is a
 * slot: pane resizes, splits and sidebar moves all shift it. */
export function useSlotRect(slot: HTMLElement | null): SlotRect | null {
  const [rect, setRect] = useState<SlotRect | null>(null)
  useEffect(() => {
    if (!slot) {
      setRect(null)
      return
    }
    let frame = 0
    let last: SlotRect | null = null
    const follow = (): void => {
      const box = slot.getBoundingClientRect()
      const next = { left: box.left, top: box.top, width: box.width, height: box.height }
      if (!sameRect(last, next)) {
        last = next
        setRect(next)
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [slot])
  return slot ? rect : null
}
