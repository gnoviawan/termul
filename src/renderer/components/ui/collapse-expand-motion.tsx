import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Collapse/expand via `grid-template-rows` 0fr→1fr (not `height`), so layout
 * work stays cheaper than animating pixel height. See animations skill.
 */
export const collapseExpandTransition = {
  duration: 0.15,
  ease: 'easeInOut'
} as const

interface CollapseExpandMotionProps {
  open: boolean
  children: ReactNode
  className?: string
  onExitComplete?: () => void
}

export function CollapseExpandMotion({
  open,
  children,
  className,
  onExitComplete
}: CollapseExpandMotionProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false

  return (
    <AnimatePresence initial={false} onExitComplete={onExitComplete}>
      {open && (
        <motion.div
          initial={reduced ? false : { gridTemplateRows: '0fr', opacity: 0 }}
          animate={{ gridTemplateRows: '1fr', opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { gridTemplateRows: '0fr', opacity: 0 }}
          transition={reduced ? { duration: 0 } : collapseExpandTransition}
          className={cn('grid overflow-hidden', className)}
        >
          <div className="min-h-0 overflow-hidden">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
