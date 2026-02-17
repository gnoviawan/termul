import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'

export interface ActivityIndicatorProps {
  className?: string
}

export function ActivityIndicator({
  className
}: ActivityIndicatorProps): React.JSX.Element {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mediaQuery.matches)

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches)
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  const animation = prefersReducedMotion
    ? {
        scale: [1, 1.1, 1],
        opacity: [1, 0.85, 1]
      }
    : {
        scale: [1, 1.15, 1],
        opacity: [1, 0.75, 1]
      }

  const transition = prefersReducedMotion
    ? {
        repeat: Infinity,
        duration: 3,
        ease: 'easeInOut' as const
      }
    : {
        repeat: Infinity,
        duration: 2,
        ease: 'easeInOut' as const
      }

  return (
    <motion.div
      animate={animation}
      transition={transition}
      className={cn('h-2 w-2 rounded-full bg-primary', className)}
      role="status"
      aria-label="Terminal has activity"
    />
  )
}
