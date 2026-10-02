import { motion, useIsPresent } from 'framer-motion'
import { EASE_OUT } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { TabReorderPosition } from '@/types/workspace.types'

/**
 * Presence-aware tab wrapper: owns the grow-in/shrink-out width tween and
 * FLIP slide for one tab item. While AnimatePresence runs the shrink-out the
 * tab is already gone from the store — `pointer-events-none` keeps a stray
 * click/drag from hitting stale tab ids mid-exit (setActiveTab writes
 * unconditionally), the same trick DropZoneOverlay uses for its exit fade.
 */
export function TabListItem({
  reducedMotion,
  children
}: {
  reducedMotion: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const isPresent = useIsPresent()
  return (
    // `layout="position"` gives reorder commits a FLIP slide;
    // position-only so width/height never tween mid-drag.
    // min-w-0/overflow-hidden/shrink-0 let the width tween
    // clip content instead of flex-clamping at min-content.
    <motion.div
      layout={reducedMotion ? false : 'position'}
      initial={reducedMotion ? false : { width: 0, opacity: 0 }}
      animate={{
        width: 'auto',
        opacity: 1,
        transition: reducedMotion ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }
      }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0 } }
          : { width: 0, opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }
      }
      transition={{
        layout: { duration: 0.18, ease: EASE_OUT }
      }}
      className={cn(
        'list-none h-full min-w-0 overflow-hidden shrink-0',
        !isPresent && 'pointer-events-none'
      )}
    >
      {children}
    </motion.div>
  )
}

// Helper to compute drop position from mouse coordinates
export function computeTabPosition(target: HTMLElement, clientX: number): TabReorderPosition {
  const rect = target.getBoundingClientRect()
  const x = clientX - rect.left
  const halfWidth = rect.width / 2
  return x < halfWidth ? 'before' : 'after'
}
