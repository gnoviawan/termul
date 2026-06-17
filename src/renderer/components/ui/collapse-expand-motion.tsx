import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Shared collapse/expand motion used by ProjectSidebar and file explorer. */
export const collapseExpandTransition = { duration: 0.15, ease: 'easeInOut' } as const

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
  return (
    <AnimatePresence initial={false} onExitComplete={onExitComplete}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={collapseExpandTransition}
          className={cn('overflow-hidden', className)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
