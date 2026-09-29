import { useReducedMotion } from 'framer-motion'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import type { ImperativePanelGroupHandle } from 'react-resizable-panels'
import type { PaneDropInfo } from '@/hooks/use-pane-dnd'
import { logFrontendError } from '@/lib/log-api'
import { easeOutCurve } from '@/lib/motion'
import type { PaneNode } from '@/types/workspace.types'

/**
 * Post-drop layout tween for `PaneSplitRenderer`.
 *
 * `splitPane` / `moveTabToNewSplit` mutate the workspace tree synchronously at
 * drop time, so a `PanelGroup` arrives at its FINAL geometry in one commit
 * and panes snap. To let a new pane grow in while neighbors settle, this hook
 * applies a start layout (new panel clamped near `minSize`, siblings scaled
 * down keeping prior ratios) in a layout effect — before first paint — then
 * interpolates `ImperativePanelGroupHandle.setLayout` toward `node.sizes` on
 * an rAF loop sampled through the `--ease-out` curve.
 *
 * A tween only runs when ALL gates hold:
 *  - `lastDrop` was recorded within {@link PANE_DROP_FRESHNESS_MS} —
 *    distinguishes drop-created mounts/splices from fullscreen toggles and
 *    project-restore remounts, which must mount at final size with no tween.
 *  - the drop position is not 'center' (a pure tab move — no geometry change).
 *  - `prefers-reduced-motion` is off.
 *  - no resize-handle drag is in flight (`isDraggingRef`) — the cursor must
 *    stay 1:1 with panel sizes; a drag starting mid-tween aborts it.
 */

/** How long a drop commit stays eligible to trigger a layout tween. */
export const PANE_DROP_FRESHNESS_MS = 400

/** Drop-created layout tween duration (~200-250ms per spec). */
const PANE_DROP_TWEEN_MS = 230

/** Start size for a drop-created panel — matches `ResizablePanel minSize`. */
const NEW_PANE_START_SIZE = 10

/**
 * `ImperativePanelGroupHandle.setLayout` throws on length mismatches (e.g.
 * panels changed under a stale tween) — catch and report so the failure is
 * diagnosable instead of crashing the renderer.
 */
function safeSetLayout(group: ImperativePanelGroupHandle | null, layout: number[]): void {
  if (!group) return
  try {
    group.setLayout(layout)
  } catch (error) {
    void logFrontendError({
      message: `Pane split layout tween setLayout failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      source: 'usePaneSplitAnimation',
      stack: error instanceof Error ? error.stack : undefined
    })
  }
}

interface UsePaneSplitAnimationOptions {
  /** `node.children` of the rendered split. */
  children: PaneNode[]
  /** `node.sizes` — the committed target layout (percentages). */
  sizes: number[]
  /** Imperative handle for the rendered `ResizablePanelGroup`. */
  groupRef: RefObject<ImperativePanelGroupHandle | null>
  /** Mirrors `PaneSplitRenderer`'s resize-handle drag guard. */
  isDraggingRef: RefObject<boolean>
  /** Drop signal from `PaneDndProvider` — gates drop-created tweens. */
  lastDrop: PaneDropInfo | null
}

/**
 * Returns `isTweeningRef`, true while a drop tween drives `setLayout`.
 * `PaneSplitRenderer` checks it inside `onLayout`: `setLayout` re-fires
 * `onLayout` every frame, and the store already holds the final sizes, so
 * intermediate frames must not be written back.
 */
export function usePaneSplitAnimation({
  children,
  sizes,
  groupRef,
  isDraggingRef,
  lastDrop
}: UsePaneSplitAnimationOptions): RefObject<boolean> {
  const reducedMotion = useReducedMotion() ?? false
  const isTweeningRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  /**
   * null until the first committed effect run distinguishes mount from update.
   *
   * NOTE (React StrictMode dev): the mount layout effect double-invokes, so
   * prevIdsRef is already set on the second run and the mount tween is
   * silently skipped — the first run's cleanup snaps to the target, so
   * geometry stays correct; only dev builds lose the grow-in. Do NOT reset
   * prevIdsRef in cleanup: a real child-set update would then be
   * misclassified as a mount.
   */
  const prevIdsRef = useRef<string[] | null>(null)
  const prevSizesRef = useRef<number[]>([])
  /**
   * Latest committed layout, refreshed during render so an effect cleanup
   * (which closes over the PREVIOUS commit's props) can still snap to the
   * sizes of the commit that is replacing it — e.g. a second drop that
   * shrinks this group 3→2 panels mid-tween.
   */
  const latestLayoutRef = useRef({ childCount: children.length, sizes })
  latestLayoutRef.current = { childCount: children.length, sizes }

  useLayoutEffect(() => {
    const ids = children.map((child) => child.id)
    const isFirstCommit = prevIdsRef.current === null
    const prevIds = prevIdsRef.current ?? []
    const prevSizes = prevSizesRef.current
    prevIdsRef.current = ids
    // Keep prevSizes aligned to a layout that actually matched the child
    // count — a mismatched sizes array must not poison the positional
    // ratio math on the next insert.
    if (sizes.length === ids.length) {
      prevSizesRef.current = sizes
    }

    const group = groupRef.current
    if (!group || reducedMotion || isDraggingRef.current) return
    if (!lastDrop || lastDrop.position === 'center') return
    if (Date.now() - lastDrop.at > PANE_DROP_FRESHNESS_MS) return
    if (sizes.length !== ids.length) return

    let startLayout: number[] | null = null

    if (isFirstCommit) {
      // Leaf -> split swaps mount a fresh 2-child group whose children are
      // [targetLeaf, newLeaf] in either order. Gate on the drop target so
      // fullscreen/restore remounts (stale or missing lastDrop) stay instant.
      if (ids.length === 2 && ids.includes(lastDrop.targetPaneId)) {
        const newIndex = ids[0] === lastDrop.targetPaneId ? 1 : 0
        startLayout = [0, 0]
        startLayout[newIndex] = NEW_PANE_START_SIZE
        startLayout[1 - newIndex] = 100 - NEW_PANE_START_SIZE
      }
    } else {
      // Same-direction insert: the drop spliced a sibling LEAF into this
      // live group. Length need not grow — a same-commit source-pane
      // collapse yields a net-zero add+remove, so gate on a non-empty added
      // set plus the drop target touching this group (either generation).
      // Only leaf additions count: a leaf -> nested-split swap also swaps a
      // child id net-zero, but that new pane lives inside the nested group,
      // which runs its own mount tween — this group's panels don't move.
      const added = new Set(
        children
          .filter((child) => child.type === 'leaf' && !prevIds.includes(child.id))
          .map((child) => child.id)
      )
      const dropTouchesGroup =
        prevIds.includes(lastDrop.targetPaneId) || ids.includes(lastDrop.targetPaneId)
      if (added.size > 0 && dropTouchesGroup) {
        const remaining = Math.max(0, 100 - NEW_PANE_START_SIZE * added.size)
        // Surviving siblings keep prior ratios scaled into the remaining
        // space; removed panes' old sizes must not skew the ratio base.
        const prevTotal = prevIds.reduce(
          (total, id, index) => (ids.includes(id) ? total + (prevSizes[index] ?? 0) : total),
          0
        )
        startLayout = ids.map((id) => {
          if (added.has(id)) return NEW_PANE_START_SIZE
          const prevIndex = prevIds.indexOf(id)
          const prevSize = prevIndex >= 0 ? (prevSizes[prevIndex] ?? 0) : 0
          return prevTotal > 0 ? (prevSize / prevTotal) * remaining : 0
        })
      }
    }

    if (!startLayout) return

    const target = [...sizes]
    isTweeningRef.current = true

    // Apply the start layout before first paint so the group never renders
    // at final size and then snaps back. The tween flag is set first so the
    // onLayout this setLayout re-fires is suppressed by handleLayout.
    safeSetLayout(group, startLayout)

    if (typeof requestAnimationFrame !== 'function') {
      safeSetLayout(group, target)
      isTweeningRef.current = false
      return
    }

    const startTime = performance.now()
    const tick = (): void => {
      if (!isTweeningRef.current) return
      if (isDraggingRef.current) {
        // A handle grab mid-tween wins: snap to the committed target first
        // so the group cannot diverge from store sizes while the drag runs,
        // then yield — the cursor stays 1:1 from whatever the drag sees.
        safeSetLayout(group, target)
        rafRef.current = null
        isTweeningRef.current = false
        return
      }
      const progress = Math.min(1, (performance.now() - startTime) / PANE_DROP_TWEEN_MS)
      const eased = easeOutCurve(progress)
      safeSetLayout(
        group,
        startLayout!.map((start, index) => start + ((target[index] ?? start) - start) * eased)
      )
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        isTweeningRef.current = false
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (isTweeningRef.current) {
        // Never leave the group parked mid-tween (e.g. effect re-run on a
        // rapid second drop) — snap to the committed target. Keep the tween
        // flag set through the snap so the resulting onLayout is suppressed
        // by handleLayout (same ordering as the tween-start setLayout), then
        // clear it. Snap to the LATEST committed layout (not this effect's
        // closed-over props — the re-run may have changed the child count),
        // and only when that layout matches its own panel count — a stale
        // target must never reach setLayout.
        const { childCount, sizes: latestSizes } = latestLayoutRef.current
        if (latestSizes.length === childCount) {
          safeSetLayout(groupRef.current, [...latestSizes])
        }
        isTweeningRef.current = false
      }
    }
  }, [children, sizes, lastDrop, reducedMotion, groupRef, isDraggingRef])

  return isTweeningRef
}
